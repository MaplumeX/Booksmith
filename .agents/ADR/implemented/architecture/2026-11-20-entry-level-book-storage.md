# ADR: Entry-level book storage with lazy binary loading and incremental saves

Status: implemented

## Problem

在 [the server-backed EPUB architecture](2026-11-19-server-backed-epub-editor.md) 与 [page-level snapshots](../feature/2026-11-19-page-level-snapshots.md) 落地后，Booksmith 的周边机制（单页快照 `page_versions`、本地草稿 `draftStore`、内置 Agent 工具原语）均已按条目粒度运行，唯独当前态 `book_files` 仍以整包 zip `bytea` 存在 Postgres 中。这造成全链路 4 处反复拆装：

1. **每次打开或从书库返回书**：前端拉取完整 `.epub`（`GET /api/books/:id/epub` 无 `304` 协商）并在浏览器主线程同步 `fflate.unzipSync` 全量解包。
2. **每次手动或自动保存**：前端重压整包 `PUT` 上传，服务端解包新包校验后再解包旧包逐条目 diff。
3. **每轮 Agent 对话**：服务端读取整包 `bytea` 并全量解包，只为了读取文本条目。
4. **每次单页快照恢复**：服务端解包整包、替换单个条目、重打包，再解包校验。

在支持 64 MB 上传上限（含大量插图与内嵌字体的书籍）的场景下，上述整包拆装导致打开与保存耗时、带宽浪费与主线程阻塞随二进制资源线性放大。

## Decision

部分替代 [the server-backed EPUB architecture](2026-11-19-server-backed-epub-editor.md) 中「整包存 `book_files`、整包 `GET/PUT` 传输」的条款，并更新 [page-level snapshots](../feature/2026-11-19-page-level-snapshots.md) 的变更比对/恢复路径与 [EPUB export](../feature/2026-11-19-epub-export.md) 的打包来源；同时保留「Postgres 单库存储、一份 `pg_dump` + 环境变量 = 完整备份」、`If-Match` 乐观锁与服务端结构门禁。

### Storage model & lossless migration

- 新增 `book_entries` 表（迁移 `apps/server/drizzle/0007_narrow_whiplash.sql`）作为书籍当前态的唯一真相源：`(book_id, path)` 联合主键，含 `position`（保留 zip 原始顺序，索引 `(book_id, position)`）、`is_text`、`media_type`、`bytes bytea`、`byte_size`、`sha256`、`updated_at`。
- `books.byte_size` 记录全部条目字节总和；`books.sha256` 记录按路径排序后的规范化条目摘要哈希（`computeManifestSha256`），无需打包即可判定空保存。
- 下线并移除 `book_files` 表。迁移由统一入口 [apps/server/src/db/migrate.ts](../../../../apps/server/src/db/migrate.ts)（`runMigrations`）顺序执行：SQL 建 `book_entries` → 幂等 `backfillBookEntries` 用 `openEpub` 将存量 `book_files` 逐本事务拆入 `book_entries`（任一旧书解包失败即抛错中止，绝不删表）→ 确认无剩余未迁移行后执行 `DROP TABLE IF EXISTS "book_files"`。大书写入按 50 条分批插入。

### Workspace loading & lazy binary delivery

- 下线 `GET/PUT /api/books/:id/epub`。
- `GET /api/books/:id/workspace` 返回 `{ version, entries, texts }`，附 `ETag: "<version>"`、`Cache-Control: private, no-cache`，命中 `If-None-Match` 返回 `304`。服务端 `listWorkspaceEntries` 通过 SQL `CASE` 仅读取文本条目与 `mimetype` 的 `bytes`，不读取或 detoast 二进制条目的 `bytea`。前端 [client.ts](../../../../apps/web/src/api/client.ts) 维护轻量内存条件缓存以复用 `304`。
- `GET /api/books/:id/entry?path=<path>&sha=<sha>` 按主键读取单条目，附 `Content-Type`、`ETag: "<sha256>"`、`X-Content-Type-Options: nosniff`（SVG 附 `Content-Security-Policy: sandbox`），命中 `If-None-Match` 返回 `304`；当 query `sha` 等于当前条目 `sha256` 时返回 `Cache-Control: private, max-age=31536000, immutable`。
- 前端 [bookStore.ts](../../../../apps/web/src/state/bookStore.ts) 直接从 `/workspace` 构建 `LoadedBook`（零 `unzipSync`），未改动远端二进制以共享 `REMOTE_BINARY_SENTINEL` 占位以复用 `packages/core` 校验与检查函数；预览、WYSIWYG（`srcDoc` iframe 内使用带 `window.location.origin` 的同源 URL）与媒体面板优先渲染本地待保存二进制（`blob:`），否则指向 `/api/books/:id/entry`。

### Atomic incremental save, snapshots, Agent & export

- `PATCH /api/books/:id/entries`（要求 `If-Match`，缺省 428、不匹配 409，支持 `x-booksmith-checkpoint: manual`）：
  - 前端 [entryDelta.ts](../../../../apps/web/src/state/entryDelta.ts) 计算最小增量（`textUpserts`、`binaryUpserts`、`renames`、`deletes`、`order`）。纯文本/重命名/删除走 `application/json` 快路径；含新增或替换二进制时走 `multipart/form-data`（客户端用标准 `FormData`，服务端在 [app.ts](../../../../apps/server/src/app.ts) 注册原始 Buffer 解析器并用 Node 22+ 内置 `Response.prototype.formData()` 解析，零新增依赖、零 base64 膨胀）。保存成功后释放本地二进制缓存。
  - 服务端在单个 Postgres 事务内按序应用：删除 → 两阶段临时路径重命名（二进制重命名零字节传输，免疫路径互换冲突）→ 分批新增/覆写 → 归一 `position` → 通过 `validateEntriesAndExtractMeta` 运行 `validateStructure` 门禁 → 更新封面与 `books` 元数据并递增 `current_version` → 对比新旧文本 `sha256` 直接写入 `page_versions` 并剪枝。
- 单页快照恢复（`POST /api/books/:id/page-versions/:snapshot/restore`）直接事务更新 `book_entries` 单行并校验，零 zip 拆装。
- 内置 Agent 回合通过 `listWorkspaceEntries` 仅读取文本与 `mimetype` 构造 `AgentWorkspace`，不解包、不读取二进制 `bytea`。
- `GET /api/books/:id/download` 按 `position ASC` 读取 `book_entries` 实时 `zipArchive` 打包：[zip.ts](../../../../packages/core/src/zip.ts) 强制 `mimetype` 首条 `level: 0`，对已压缩媒体后缀（`jpg/jpeg/png/gif/webp/woff/woff2/mp3/mp4/m4a/ogg/webm`）使用 `level: 0`，其余 `level: 6`。

## Alternatives considered

**仅前端 IndexedDB 缓存已解包结果 + `GET /api/books/:id/epub` 补 `304`**。改动最小且不碰数据库迁移，但无法解决自动保存整包重压上传、大书首次打开阻塞、以及服务端保存/Agent/恢复反复解包的根本问题。放弃。

**服务端解包到宿主机/容器磁盘目录**。Node 读大文件最轻，但直接破坏「一份 `pg_dump` + 环境变量 = 全库备份」的运维模型，容器需额外管理数据卷与 DB/磁盘双写一致性。放弃。

**保留 `book_files` 作为惰性导出缓存**。可避免同一版本反复下载时重打包并保持未编辑书原 zip 外壳哈希，但在自托管场景下载频次极低，不值得维护双表存储与缓存失效路径。放弃。

**连文本章节也按需单文件懒加载**。对上千万字纯文本书首屏更轻，但全文搜索、全书批量替换、结构检查/断链扫描与重命名全书引用重写全部失去内存本地能力，必须搬去服务端或点击时全量回拉，收益不抵复杂度。放弃。

**二进制新增/替换当下直传服务端，不随增量 `PATCH` 提交**。保存接口可保持纯 JSON，但破坏图片变更与 `content.opf` 改动的原子性，未保存关页或 409 冲突时会残留孤儿资源且无法取消替换。放弃。

**保留 `GET /api/books/:id/epub` 只读兼容端点**。下载导出已有独立 `/api/books/:id/download`，且无外部调用方依赖 `/epub`，继续维护只会留下重复路由。放弃。

## Consequences

**验收结果（2026-11-20 – 2026-11-21）**

- 全仓类型检查与构建：`pnpm -r typecheck && pnpm -r build` 全部通过（`core` / `server` / `web` 0 错）。
- 核心与前端单测：`pnpm test` **253/253 通过（27 个文件）**，覆盖 `zipArchive` 已压缩媒体 `level: 0`、远端资源依赖追踪、`buildEntryDelta` / `applySavedEntriesToBook` 与 Agent 提案撤销。
- 服务端集成测试：`pnpm --filter @booksmith/server test` **63/63 通过（7 个文件）**，覆盖 `book_entries` 读写与不 detoast 二进制、两阶段互换重命名、旧 `book_files` 无损回填及损坏中止保护、`/workspace` 与 `/entry` 缓存及 `304`、JSON/`FormData` 原子增量保存与结构校验回滚、单页恢复、Agent 零解包回合及导出逐条目字节保真。
- 端到端测试：目标 8 个 Playwright 文件（`save` / `asset` / `filetree` / `export` / `history` / `preview` / `wysiwyg` / `agent`）**34/34 通过**，实测验证 `srcDoc` 预览与 `MediaPane` 携带 Cookie 按需加载 `/entry`、文本编辑与图片重命名走纯 JSON 增量保存、导出 `.epub` 的 `mimetype` 与图片均为 `level: 0` 且字节完整。
- 全量 `pnpm e2e` 76/77 通过，唯一失败项为 HEAD 上既有的 `e2e/panels.spec.ts:43`（TOC 单击改名陈旧用例，与本次改动无关）：waived by user, 2026-11-21。
- 10–64 MB 真实大书浏览器 Network 抽查与外部阅读器打开验证：waived by user, 2026-11-21。

**代价与已知限制**

- **迁移不可逆**：`runMigrations` 回填完成后会执行 `DROP TABLE IF EXISTS "book_files"`。含既有真实数据的实例在升级执行 `db:migrate` 前须先用 `scripts/backup.sh` 留存 `pg_dump` 备份。
- **未编辑书外层 zip 哈希变化**：导出由 `fflate` 按条目实时重打包，内部所有未改动条目内容与顺序 100% 字节等价、`mimetype` 首条无压缩，但未编辑书的外层 `.epub` 容器字节不再与原上传文件逐字节一致。
- **全书文本仍一次载入前端内存**：极端超长纯文本无图书籍首屏仍会拉取全部文本，以换取全文检索、结构检查与批量替换在浏览器内毫秒级完成。
- **并发粒度保持整书乐观锁**：单文件级并发合并留待后续需求评估。
