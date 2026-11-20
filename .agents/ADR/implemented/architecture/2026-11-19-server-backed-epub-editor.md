# ADR: Server-backed EPUB editor with Postgres blob storage

Status: implemented

## Problem

Booksmith 要在浏览器里编辑 EPUB，同时需要"后端数据库"。原始设想是纯前端单页应用
（Epub 在内存里解包、编辑、下载），但一旦引入书库、账号与版本，纯前端就无法承载：
书需要归属某个用户、需要有版本可回滚、需要换设备继续编辑。另一方面使用者明确表示
**当前不对外提供服务**，只有一个基本的多用户系统，因此不能把架构建立在 CDN、对象存储
与多实例这类运营设施上。

约束来自三个已核实的现场事实：

- 目标书 `马克思经济学与数理分析.epub` 是 EPUB 3.0、55 个 zip 条目、2.1MB、25 章，
  最大单章 174KB，含 328 个内联 `<math>`，同时存在 `nav.xhtml`（177 项三层嵌套）与 `toc.ncx`。
- 编辑器必须保真：未修改的条目在保存后必须字节等价，`mimetype` 必须是首条且不压缩。
- 开发机没有 Docker、没有 psql，sudo 需要密码。任何"用容器起库"的验证路径都不可执行。

## Decision

```
apps/web      Vite + React + CodeMirror 6
apps/server   Fastify + Drizzle + @node-rs/argon2
packages/core EPUB 引擎（同构）：unpack / parse / pack / validate / search / nav / ncx / opfWrite / create
```

**编辑在浏览器完成，存储在服务端。** `GET /api/books/:id/epub` 取回整包（响应带
`ETag: "<version>"`）→ `core.openEpub` 进内存 → 用户编辑 → `core.zipArchive` 重新打包 →
`PUT` 整包。单实例、2MB 量级，不做增量协议。（*更新：此整包存储与 `GET/PUT /epub` 传输条款已由 [entry-level book storage](2026-11-20-entry-level-book-storage.md) 替代，当前改用 `book_entries` 按条目存储、`/workspace` + `/entry` 按需加载与 `PATCH /entries` 增量提交，其余单库 Postgres / `pg_dump` / 乐观锁 / 结构门禁约束保持不变。*）

**服务端是信任边界。** 落库前由 `apps/server/src/epub/ingest.ts` 校验：zip 可读、`mimetype`
为首条且内容为 `application/epub+zip`、`META-INF/container.xml` 与 OPF 可解析、结构自检
（manifest 引用的文件存在、spine 的 idref 可解析、EPUB3 有 nav）。Node 无 `DOMParser`，用
`@xmldom/xmldom` 注入。

**二进制存 Postgres `bytea`，藏在 `FileStore` 接口后面**（`apps/server/src/storage/fileStore.ts`
的 `put/get/list/markPinned/prune`）。全书库备份等于一份 `pg_dump`；将来换 S3 只需替换该实现。

**并发用乐观锁**：`PUT /api/books/:id/epub` 必须带 `If-Match`，缺失返回 428，不匹配返回 409
并附 `currentVersion`；前端提示冲突，由用户决定重新加载或放弃。

**版本快照**：每次保存插入一行 `book_versions`（`versionNo` 递增），`prune` 保留最新 20 版，
`pinned` 的版本不参与修剪；恢复是把旧版字节写成新版本（`POST …/versions/:n/restore`），不删历史。

表结构：`users` / `sessions` / `books` / `book_versions`。`books` 含 `owner_id`、`tenant_id`
（保留未启用）、`title/author/language/identifier`、`chapter_count`（= spine 文档数）、
`byte_size`、`sha256`、`cover bytea` + `cover_mime`、`current_version`；`book_versions` 含
`version_no`、`bytes bytea`、`sha256`、`note`、`pinned`。索引：`books(owner_id, updated_at)`、
`book_versions(book_id, version_no)` 唯一。

**部署**：开发用 `embedded-postgres`（PG 18.6，数据在 `.pgdata/`，无需 root）；生产用
`Dockerfile` + `docker-compose.yml`（Postgres 18 + 单容器应用）。设置 `WEB_DIST` 时由 Fastify
托管构建好的前端，`/api/*` 之外的回退到 `index.html`。

## Alternatives considered

**纯前端 SPA + 导入/导出**（最初 Q1=C/Q5=B 的方向）。它最快，零安装，且当时的 MVP 不需要
账号。引入书库与版本后它无法承载：没有归属、没有历史、换设备即断。放弃。

**Tauri 2 或 Electron 桌面壳**。Tauri 体积小、有原生文件关联，但本机缺 `webkit2gtk-4.1`
且 sudo 需要密码，构建链无法验证；Electron 用 100MB 包体换一个这个产品用不到的原生菜单。
两者都在"要后端数据库"之后失去意义。

**对象存储（S3/MinIO）存书**。是公网多用户的标准答案，能独立扩容与备份。但使用者的真实
需求是"内部多用户、不对外"，多一个容器与一套预签名逻辑换不到任何当期收益。窗口留在
`FileStore` 接口后面。

**SQLite / PGlite 作为生产库**。SQLite 单写者，多用户并发下是死路；PGlite 是 WASM 测试
替身，不是运行时。二者都只作为测试期的退路，不进运行时。

**现成 EPUB 库（`epub-editor`、`epubkit`、`epub.js`）**。它们以读写 API 为中心，会重排
结构与丢弃未知条目，与"未修改条目字节等价"直接冲突。EPUB 容器层自己写。

**File System Access API 原地保存**。只在 Chromium 生效，且与"书在服务器上"互斥。

## Consequences

**验收结果（2026-11-19）**

- 上传真实书 → 下载 sha256 一致；`mimetype` 首条且 `level 0`；仅被修改的章节字节变化。
- 两个标签页先后保存，第二个收到 409 且不覆盖；恢复旧版后 `ETag` 递增、内容与源版本一致。
- 未登录 401、访问他人书籍 404、非法 id 不触库；非 epub 上传 400。
- 版本修剪保留最新 20 条（server 测试断言）。
- `embedded-postgres` 在 Ubuntu 26.04 上实测可初始化、启停、迁移，**未触发 PGlite 退路**。
- 全书库备份命令为 `scripts/backup.sh`（`pg_dump --format=custom`）。开发机只有
  `initdb/pg_ctl/postgres` 三个二进制、没有 `pg_dump`，**备份产物的可读性未在本机验证**，
  由用户豁免，需在有 postgres-client 或 Docker 的环境补验。

**代价与已知限制**

- `bytea` 存书让每次下载都过应用进程。内部使用无碍，对外服务前必须迁到对象存储。
- 整包 `PUT` 在书籍明显变大（>50MB）时会变慢；届时改用条目级差异上传。
- 只支持单实例：没有共享会话、没有分布式锁，`tenant_id` 字段存在但未启用。
- `pinned` 在存储层与版本列表里存在，但没有"标记/取消"的 API 与 UI，当前只由恢复流程之外的
  手工 SQL 维护。
- `@xmldom/xmldom` 与浏览器 `DOMParser` 的差异在极端 XML 上仍可能显现；两侧共用同一套断言，
  但没有 fuzz 覆盖。
