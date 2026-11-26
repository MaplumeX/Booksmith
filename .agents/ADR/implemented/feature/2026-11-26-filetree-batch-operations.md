# ADR: File tree full-group multi-select, batch rename, batch delete, and batch spine reorder

Status: implemented

## Problem

[章节结构与资源工具决策](2026-11-21-chapter-structure-and-resource-tools.md) 为文件树引入了 `TEXT` 分组的多选合并章节与批量关联样式表，但真实整理 EPUB 书稿时仍有四类高频批量缺口：

1. **非章节分组无法多选**：`STYLES`、`IMAGES`、`OTHER` 分组无法勾选，清理多余图片或样式表只能逐个右键删除，且无法一次同时选中「废弃章节 + 对应配图」一并清理。
2. **缺少批量删除、批量重命名与批量移序**：文件树虽然支持合并与关联样式表，但整理导入的长稿或批量重整章节/图片命名（如顺延编号 `ch001.xhtml`、替换前缀 `fig_ → img_`、成块调整多章阅读顺序）仍须逐文件重复操作，也没有全局或分组级全选。
3. **`256px` 窄栏单行批量条承载不足且与目录面板割裂**：原单行 `.tree-batch-bar` 塞不下扩展后的批量动作，也不随列表滚动固定；同一悬浮岛内「目录」标签页 [TocPanel.tsx](../../../../apps/web/src/ui/TocPanel.tsx) 已采用两行吸顶批量栏与键盘快捷键，两者交互不统一。
4. **删除/重命名/移序缺少工作区撤销安全网**：单文件删除、重命名与上移/下移尚未接入 20 步 `structureHistory` 工作区撤销栈，批量删改若无一键还原会显著提高误操作心理门槛。

## Decision

基于 [文件结构编辑决策](2026-11-19-file-structure-editing.md)、[章节结构与资源工具决策](2026-11-21-chapter-structure-and-resource-tools.md) 与 [Soft Craft Studio 设计系统](../design/2026-11-20-soft-craft-studio-ui.md)，将文件树升级为全分组跨组多选与统一可撤销的批量管理工作台：

### 1. `@booksmith/core` 批量文件操作内核
- **受保护路径判定**：`isProtectedArchivePath(path, pkg)`（[batchFiles.ts](../../../../packages/core/src/batchFiles.ts)）仅将删除或改名会直接破坏 EPUB 容器解析的核心文件（`META-INF/container.xml`、`mimetype` 与 `pkg.opfPath`）标记为不可勾选；其余文件均允许参与批量操作。
- **原子批量重命名（[opfEdit.ts](../../../../packages/core/src/opfEdit.ts)、[references.ts](../../../../packages/core/src/references.ts)、[batchFiles.ts](../../../../packages/core/src/batchFiles.ts)）**：
  - `renameManifestEntries` 在单次 OPF DOM 遍历中先按原始路径快照命中节点再统一改写 `<item href>`，避免链式/互换重命名（如 `ch002 → ch001` 与 `ch001 → ch000`）中途碰撞；`rewriteReferences` 增加可选 `skipPaths` 以跳过已由 DOM 更新的 OPF，防止二次替换。
  - `planBatchRename` 支持三种规则模式——**按序编号**（前缀 + 起始号 + 补零位数）、**查找替换**（普通文本，可选区分大小写）、**添加前后缀**——默认锁定原扩展名，并在执行前校验非法字符、空文件名、同批目标冲突及与未参与改名文件的路径冲突（允许同批互换与链式移位）。
  - `renameFilesInBook` 原子同步 OPF manifest、正文/CSS/目录（`nav.xhtml`、`toc.ncx`）引用及归档条目映射，全程保留正文未改动字节原样。
- **原子批量删除与风险检查**：
  - 复用 [stylesheets.ts](../../../../packages/core/src/stylesheets.ts) 导出的 `findCoverPaths` 识别 EPUB 3 `cover-image` 与 EPUB 2 `<meta name="cover">` 封面图。
  - `inspectBatchDelete` 汇总外部引用（按被删目标分组，自动排除同批一并删除的内部互引，保留行号定位），并标出是否包含目录文件（`nav`/`ncx`）、封面图或将删空全部正文章节。
  - `deleteFilesInBook` 经 `removeManifestEntries` 原子移除 manifest/spine、修剪留存 `nav`/`ncx` 失效目录项并删除归档条目。
- **非连续章节保距移序**：`getBatchSpineMoveCapability` 与 `computeBatchSpineMove` 将多选章节按当前 spine 相对间距整体平移 1 位，首项到顶禁上移、末项到底禁下移，连续上移/下移完全可逆。

### 2. 文件树全分组多选、两行吸顶批量栏与局部快捷键（`apps/web`）
- [FileTree.tsx](../../../../apps/web/src/ui/FileTree.tsx) 改为顶部固定工具区 + 独立滚动分组列表：未激活多选时顶部展示轻量「多选」开关（外加 `Shift` 跨组连选 / `Ctrl`/`Cmd` 逐项多选直达）；激活多选后显示对齐 `TocPanel` 的两行吸顶 `.tree-batch-bar`（第一行 `已选 N 项` + `全选/取消全选` + `完成`，第二行 6 列紧凑图标按钮：`上移 / 下移 / 合并 / 样式表 / 重命名 / 删除`），按选中集合自动启禁用并写明禁用原因 `title`。
- 各分组标题右侧在多选模式下展示组内一键全选/取消全选按钮；受保护容器文件以锁形图标标识且不可勾选；右键点击已选中文件（多于 1 项）时，`ContextMenu` 自动呈现对应批量操作项。
- 键盘快捷键严格限定在 `.filetree` 容器焦点内：`Esc` 退出多选、`Cmd/Ctrl+A`（仅多选模式生效，避免抢占编辑器全选）全选可选文件、`Alt+↑/↓` 批量调整章节顺序、`Delete`/`Backspace` 唤起批量删除确认弹窗。

### 3. 批量重命名与统一删除确认弹窗 + 20 步工作区撤销
- 新增 [BatchRenameDialog.tsx](../../../../apps/web/src/ui/BatchRenameDialog.tsx)（`min(560px, calc(100vw - 32px))`）：三模式分段切换、默认锁定扩展名、实时「原名 → 新名」对照预览表与状态标注，存在冲突或无有效变更时禁用提交。
- 新增 [BatchDeleteDialog.tsx](../../../../apps/web/src/ui/BatchDeleteDialog.tsx)（`min(480px, calc(100vw - 32px))`）：统一承接单文件与批量删除确认，呈现特殊资源风险提示标签与按文件分组的可跳转外部引用清单。
- [Editor.tsx](../../../../apps/web/src/routes/Editor.tsx) 将批量与单文件的删除、重命名、移序全部纳入既有 20 步 `structureHistory` 撤销栈；通过 `remapBookAfterRenames` 使用新 Map 原子迁移 `entryMeta`、`entryOrigins`、`localBinaries`、`tabs` 与 `active`（直接兼容服务端两阶段临时路径增量保存 [fileStore.ts](../../../../apps/server/src/storage/fileStore.ts)），批量重命名后同步映射文件树选中路径，批量移序保持选中态并原地更新 Toast。所有新组件已登记至 [DESIGN.md](../../../../DESIGN.md)。

## Alternatives considered

**仅允许单组内多选（切换分组时清空前一组选中）。** 虽能让批量栏按钮始终纯粹，但无法一次清理「废弃章节 + 对应配图」，且通过按选中类型动态启禁用按钮并提供明确禁用原因即可消除跨组操作歧义。

**将 `nav.xhtml`、`toc.ncx` 与封面图一并硬禁选。** 更防呆，但会阻止作者批量替换旧封面或清理冗余 EPUB 2 NCX 目录；改为在删除弹窗给出醒目风险标签并由工作区撤销栈兜底更合理。

**批量重命名仅支持按序编号，或增加正则/逐行手工编辑。** 仅按序编号无法处理图片/样式表前缀替换；正则与逐行编辑显著增加弹窗复杂度且易误伤。三模式（按序编号 / 查找替换 / 添加前后缀）+ 锁定扩展名覆盖主流场景且足够克制。

**非连续章节移序时先聚拢为连续块再整体移动。** 第一次点击方向不直观且不可逆；保持相对间距平移 1 步与隔壁 `TocPanel` 一致且连续上下移完全可逆。

**不把单文件删除/重命名/移序纳入 `structureHistory` 撤销栈。** 改动面略小，但会造成「删 2 个文件能一键撤回，删 1 个文件不能撤回」的割裂体验；统一收口到同一执行路径反而减少重复代码。

**本期一并做拖拽批量重排、批量复制与新 AI 批量工具。** 拖拽需额外补齐多选拖影与键盘无障碍路径；AI 助手已有对应原子写工具，本期聚焦文件列表工作台体验。

## Consequences

**交付与验收实测（2026-11-26）**

- `pnpm typecheck && pnpm build`：全仓 3 个包（`core` / `server` / `web`）类型检查与构建通过（`apps/web` 2337 modules）。
- `pnpm test`：41 个测试文件、357 条单元测试全绿（含新增 `packages/core/test/batchFiles.test.ts` 与 `apps/web/src/styles/tokens.test.ts` 53 条对比度检查）；`pnpm --filter @booksmith/server test`：8 个测试文件、81 条服务端集成测试全绿。
- `pnpm e2e e2e/filetree.spec.ts e2e/structure.spec.ts`：13/13 全绿（覆盖跨组多选、容器文件禁选、冲突拦截、查找替换、链式编号重命名保存刷新、跨组批量删除内部互引过滤与封面风险警示、非连续章节 `Alt+↑/↓` 移序与 Toast 撤销，以及原有拆章/合章/样式表/未引用清理回归）。
- `node e2e/audit-shots.mjs`：输出 `audit: clean`；已复核 `editor-1440.png` 与 `editor-dark-1440.png` 亮/暗双主题渲染无溢出。

**已接受的代价与长期约束**

- 客户端迁移 `entryMeta` / `entryOrigins` / `localBinaries` / `tabs` 时必须通过新 Map 单次构造而非原地 `delete` + `set`，否则链式或互换重命名会相互覆盖并破坏服务端零字节增量重命名。
- 批量重命名仅修改同目录内的文件名，不支持跨目录移动文件（跨目录移动需同步重算被移动文件内部所有相对 `href`/`src`/`url()`，留待后续独立需求）。
- 文件树快捷键中的 `Cmd/Ctrl+A` 仅在多选模式激活且焦点位于 `.filetree` 非输入元素内时生效，避免影响代码或可视化编辑器的全选习惯。
