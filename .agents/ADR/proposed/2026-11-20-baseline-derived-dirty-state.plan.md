# Plan: Baseline-derived dirty state and external-sync isolation

ADR: bug-fix/2026-11-20-baseline-derived-dirty-state.md
Constrained by: ../implemented/feature/2026-11-19-autosave.md
Constrained by: ../implemented/bug-fix/2026-11-19-editor-state-per-tab.md
Constrained by: ../implemented/feature/2026-11-19-opf-meta-editing.md
Constrained by: ../implemented/feature/2026-11-20-wysiwyg-editing-mode.md

## Scope

将编辑器未保存状态改为基于服务端已保存基线（`SavedBaseline`）的纯函数推导模型，并在 `CodePane` / `wysiwygXhtml` 边界隔离编程式外部同步与保留原文件行尾风格（CRLF/LF），同时修复在途保存竞态、撤销消脏、删除文件漏标脏、替换图片误标 OPF 与切书重装问题。

## Not in scope

- 不扩展 `draftStore`（IndexedDB）存储二进制或删除清单，保持纯文本本地草稿。
- 不改动服务端保存协议、快照策略或 Agent 提案数据结构。
- 不改 UI 视觉样式与文案框架。
- 不修改 `MetadataPanel` 的「还原未修改的值」按钮语义。

## Steps

1. 行尾工具与基线脏状态纯函数模块 — 新增 `apps/web/src/editor/eol.ts`、`apps/web/src/editor/eol.test.ts`、`apps/web/src/state/dirtyState.ts`、`apps/web/src/state/dirtyState.test.ts`。
   - `eol.ts`：`normalizeEol`、`detectEol`、`applyEol`、`restoreEol`（覆盖 LF、CRLF、孤立 CR、混合行尾与撤销回种子串字节级还原）。
   - `dirtyState.ts`：`createSavedBaseline`、`computeDirtySummary`（文本改/增、二进制改/增的引用快路径 + 字节比对、删除条目检测）、`setsEqual`。
   - 单测覆盖 CRLF/混合行尾还原、撤销消脏、在途保存部分推进基线、二进制替换不污染 OPF、删除条目计入未保存。
   Verify: `pnpm test apps/web/src/editor/eol.test.ts apps/web/src/state/dirtyState.test.ts` — passed 2026-11-20: 10 tests (2 files)

2. 隔离 `CodePane` 外部同步与保留 `wysiwygXhtml` 原行尾 — 修改 `apps/web/src/ui/CodePane.tsx`、`apps/web/src/editor/wysiwygXhtml.ts`、`apps/web/src/editor/wysiwygXhtml.test.ts`。
   - `CodePane.tsx`：新增 `externalSyncAnnotation` 标记所有 props 驱动的 `instance.dispatch`，`updateListener` 忽略纯外部同步事务；同步比对改为 `instance.state.doc.toString() === normalizeEol(content)`；按路径维护 `seedTexts` 并通过 `restoreEol` 写回原行尾风格；`resetVersion` 触发时重设 `seedTexts`。
   - `wysiwygXhtml.ts`：`replaceBodyInXhtml` 按 `detectEol(originalXhtml)` 统一 `serializedBody` 行尾，并补充 CRLF 章节往返单测。
   Verify: `pnpm test apps/web/src/editor/wysiwygXhtml.test.ts && pnpm --filter @booksmith/web typecheck` — passed 2026-11-20: 5 tests (1 file) + tsc clean

3. 在 `Editor.tsx` 接入基线脏状态模型并修复在途保存与切书清理 — 修改 `apps/web/src/routes/Editor.tsx`、`apps/web/src/App.tsx`。
   - `App.tsx`：为 `<Editor key={match[1]} bookId={match[1]} />` 添加 `key`。
   - `Editor.tsx`：引入 `baselineRef` 与 `syncDirtyFromBaseline()`，在 `applyBook` / `reload` 初始化基线；所有变更与撤销入口统一经 `syncDirtyFromBaseline()` 更新 `dirtyRef.current` 与 `dirty` state，移除手维 `beforeDirty`/`afterDirty` 及 `replaceAsset` 借 `opfPath` 占位逻辑。
   - 修复 `save()`：从 `bookRef.current` 读取最新状态，仅当 `summary.texts.has(opfPath)` 时执行 `touchOpfModified`；请求成功后仅将基线推进到本次上传快照并重算剩余脏集合，保留在途新编辑。
   - 修复 `scheduleDraft()` 与 `autosave`：`summary.texts.size === 0` 时主动 `clearDraft`，`summary.all.size === 0` 时 `autosave.current?.cancel()`。
   Verify: `pnpm typecheck && pnpm build` — passed 2026-11-20: 3 packages typecheck & build clean (web 2316 modules)

4. 补齐 E2E 回归用例并跑通相关场景 — 新增 `e2e/dirty.spec.ts`（覆盖 CRLF 打开不标脏、CRLF 编辑保存保留行尾、撤销回原样消脏、可视化保存后切回代码不标脏、删除文件标脏并保存持久化、换图仅图片亮红点不污染 OPF）。
   Verify: `pnpm exec playwright test e2e/dirty.spec.ts e2e/save.spec.ts e2e/asset.spec.ts e2e/wysiwyg.spec.ts` — passed 2026-11-20: 19 passed (4 spec files)

## Verification

- [x] 全量类型检查、构建与单元测试通过：`pnpm typecheck && pnpm build && pnpm test` — passed 2026-11-20: 3 packages typecheck/build clean (web 2316 modules), 262 tests (28 files)
- [ ] 全量 Playwright E2E 回归通过：`pnpm e2e` — 79/80 passed 2026-11-20; 1 pre-existing failure on main: `e2e/panels.spec.ts:43`（`.toc-label` 单击在 `b1c0990` 后已改为跳转章节而非内联改名，非本次变更引入）
- [ ] 手工核验：打开本地触发该问题的真实 EPUB（含 CRLF 章节），逐个点开章节并在代码/可视化间切换，确认无虚假「未保存的修改」与本地草稿横幅 — not run

## Prerequisites

- 本地后端服务与 PostgreSQL 可用，且已安装 Playwright Chromium（用于 Step 4 与全量 `pnpm e2e`；前端 Vite 服务由 `playwright.config.ts` 自动拉起）。
