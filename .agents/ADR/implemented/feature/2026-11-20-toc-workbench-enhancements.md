# ADR: Enhanced TOC navigation, outline editing, heading generation, and agent tools

Status: implemented

## Problem

[目录基础编排决策](2026-11-19-toc-authoring.md) 交付了新增条目、上下移与缩进/取消缩进，但在真实长书稿（例如 177 项三层结构）的编辑场景下仍有显著缺口：

1. **浏览与定位缺失**：点击目录标题直接进入改名而非跳转对应章节与 `#anchor`；缺少折叠/展开、按级展开、关键词过滤与当前项高亮。
2. **大纲编排易错且低效**：取消缩进中间子节点会将其直接移到父项之后，导致阅读顺序倒挂；删除父节点静默丢弃整棵子树；无法修改已有条目的 `href`（包括原地修复「锚点失效」）、无法在指定节点附近/子级插入、无拖拽排布、无多选批量调级，也缺少目录撤销栈。
3. **无安全可控的正文标题生成与初始化**：作者重构或新建书籍时，无法按选定标题层级（`h1`–`h6`）扫描正文生成或补全目录；缺少 `nav.xhtml` 与 `toc.ncx` 的书稿完全无法进入目录编辑。
4. **底层同步与 AI 工具不足**：前端编辑器对纯 EPUB2（仅有 `toc.ncx`）误用 `readNavToc`、写回 `ncx` 未重算跨目录相对路径、`suggestTitle` 未解析相对路径；[内置 AI 助手](2026-11-20-builtin-epub-agent.md) 仅有 `get_toc` 与整树替换式 `update_toc`，微调大目录易丢项并损失条目内联 MathML `rawHtml`。

## Decision

在保留 [目录基础编排决策](2026-11-19-toc-authoring.md) 关于 `rawHtml` MathML 保真、`nav.xhtml`/`toc.ncx` 镜像同步与 `playOrder` 重排约束的前提下，本决策演进其大纲升级语义与自动生成边界，并遵循 [Soft Craft Studio 设计系统](../design/2026-11-20-soft-craft-studio-ui.md)：

### 1. 大纲保序与完整子树编排（`@booksmith/core`）
- **保序取消缩进**：`outdentTocEntry` 将目标节点提升至父节点之后，并把原父节点中位于其后的同级兄弟依次收编为该节点的末尾子项，确保全书阅读顺序绝不倒挂。
- **子树操作与安全删除**：缩进、取消缩进、拖拽移动（`moveTocSubtree` 支持 `before` / `inside` / `after`，拒绝拖入自身及子孙路径）均携带完整子树；`removeTocEntry` 支持 `keepChildren: true`（将子项原地提升一级）与整子树删除两种模式。
- **多选批量操作**：对选中路径先做祖先去重（`normalizeTocPaths`），再执行批量缩进（`indentTocEntries`）、取消缩进（`outdentTocEntries`）、移动（`moveTocEntries`）、删除（`removeTocEntries`）与断链清理（`removeBrokenTocEntries`，保留有效子项）。所有操作仅改写目录树，不改写正文 XHTML 的 `<h1>`–`<h6>` 标签。
- **底层路径与格式修正**：导出统一 `rebaseTocHrefs` 供编辑器与 Agent 共用；修复纯 EPUB2 仅 `toc.ncx` 读取与跨目录镜像写回、修正 `suggestTitle` 相对路径解析；新增 `initializeBookToc`（`packages/core/src/tocInit.ts`）为缺失目录的书籍按版本创建 `nav.xhtml`（注册 `properties="nav"`）或 `toc.ncx`（注册 `spine@toc`）。

### 2. 可控的正文标题扫描、锚点注入与生成/刷新引擎（`packages/core/src/tocGenerate.ts`）
- 使用 `XmlCodec` 实现 `listDocumentAnchors` 与 `scanBookHeadings`，按 spine 顺序扫描 `h1`–`h6` 标题与章内可用 `id`/`name` 锚点。
- **可勾选标题层级**：`generateTocFromHeadings` 支持自由选择纳入的级别集合（默认 `[1, 2, 3]`），通过单调栈自动折叠跳级空缺（例如仅选 `h2`+`h4` 形成两级树），可选将无匹配标题的 spine 章节按 `<title>` 或文件名补入（`includeUntitledSpine`）。
- **可控自动补 `id`**：默认开启为选中的无 `id` 标题写入文档内唯一 `id`（`toc-N`），弹窗中明示受影响章节数并允许取消勾选；提供 `append_missing`（保留既有手工标题、MathML 与层级，仅追加缺失项）与 `replace`（重建目录）两种落盘模式。
- **标题文字刷新**：`refreshTocLabelsFromHeadings` 按目标章节/锚点刷新选中项或全部条目的文字，默认跳过含内联 MathML/富文本标记的条目。

### 3. 混合交互界面与 50 步目录撤销栈（`apps/web`）
- **左侧 `256px` 目录栏**（`apps/web/src/ui/TocPanel.tsx`）：单击跳转到目标章节与 `#anchor`（同步滚动 `CodePane`、`WysiwygPane` 与 `PreviewPane` 三端）并高亮当前项；双击或 `F2` 改名；行内仅保留折叠箭头与行尾 `···` 下拉菜单触发器（与右键 `ContextMenu` 共用完整动作集）；提供实时过滤、按级展开（`1 级 / 2 级 / 全部`）、仅看断链筛选、原生 HTML5 拖拽、复选/Shift 连选批量栏、选中态快捷键（`F2` / `Tab` / `Shift+Tab` / `Alt+↑/↓` / `Delete` / `⌘Z` / `⌘⇧Z`）以及缺失目录空态初始化。
- **按需居中弹窗**：`TocLinkDialog`（`.dialog.toc-link-dialog`，`width: min(480px, calc(100vw - 32px))`，支持目标文件与章内 `#id` 选择器及原地修复断链）与 `TocGenerateDialog`（`.dialog.toc-gen-dialog`，`width: min(680px, calc(100vw - 32px))`，含 `H1`–`H6` 勾选、补 `id` 开关与章节计数、预览树单条勾选/调级、补全/重建切换）。
- **目录撤销/重做栈**（`apps/web/src/routes/Editor.tsx`）：最多保留 50 步目录编辑快照，原子保存并还原 `nav`/`ncx` 与因自动补 `id` 顺带修改的章节文本及脏状态。

### 4. 内置 AI 助手精准目录工具
- 在 `AgentWorkspace`（`packages/core/src/agentTools.ts`）、服务端 `runner.ts` / `systemPrompt.ts` 与前端 `AgentPanel.tsx` 新增 `scan_headings`、`generate_toc`、`edit_toc` 三个工具，直接复用 `@booksmith/core` 目录引擎；保留现有 `get_toc` / `update_toc` 向后兼容，避免 Agent 微调长目录时全量重写导致丢项或丢失内联 MathML。

## Alternatives considered

**保持旧 `outdent` 行为（后续兄弟留在原父下）。** 当父项含 `[A, B, C]` 时把 `B` 升一级会产出 `父 → A → C → B` 的错乱顺序，在书籍目录场景下属于逻辑错误，因此改为大纲保序语义。

**调整目录层级时同步改写正文 `<h1>`–`<h6>` 标签。** 容易破坏依赖特定标题标签选择器的书内 CSS 排版，且跨章多文件副作用大，决定明确不改正文标题标签。

**绝不向无 `id` 正文标题写入锚点。** 虽可保证生成目录不碰章节文件，但同章多个无 `id` 二级/三级小节会全部指向章首，无法精准定位；改为默认开启、弹窗明示改动数、可取消且受撤销栈保护的折中方案。

**将所有编排操作塞进左侧 `256px` 侧栏，或另建独立总弹窗取代侧栏编辑。** 前者会导致标题扫描预览与锚点选择极度拥挤，后者会打断随手微调与跳转校对的节奏，且偏离 Soft Craft Studio「轻侧栏 + 按需浮层工具」的设计体系。

**在侧栏每行悬停保留缩进/移动等 5 个微缩按钮。** 加入折叠箭头、断链标记与复选后，`256px` 窄栏会被行内按钮严重挤占；精简为行尾 `···` 菜单触发器 + 右键菜单 + 拖拽 + 快捷键，最大化标题可读宽度。

**内置 AI 助手仅新增 `generate_toc` 而不提供 `edit_toc`。** 微调 177 项目录中的个别层级或修复断链仍需模型输出整棵树，Token 成本高且极易丢项或丢失内联 MathML `rawHtml`。

**同步纳入 EPUB3 `landmarks` 与内文 HTML 目录页生成。** 涉及 OPF spine 排布与阅读器语义导览配置，范围与当前核心痛点正交，留作后续独立议题。

## Consequences

**交付与验收实测（2026-11-20）**

- `pnpm typecheck && pnpm build` 全仓 3 个包通过；`pnpm test` 241 tests（25 files）与 `@booksmith/server` 57 tests（6 files）全部通过（含 `tocEdit.test.ts`、`tocInit.test.ts`、`tocGenerate.test.ts` 与 `agentTools.test.ts` 新增用例及真实 MathML 书稿往返）。
- `pnpm e2e e2e/toc.spec.ts e2e/agent.spec.ts` 8 tests（2 files）全部通过，涵盖单击跳转高亮、弹窗选锚点新增/修断链、按级展开与过滤、多选批量缩进、保留子项删除、保序取消缩进与撤销/重做、自定义层级生成目录、以及浅/暗色主题零横向溢出与零控制台报错。
- 对比度校验（`check_contrast.py`）覆盖 14 组浅/暗语义配色，实测 `5.29:1`–`16.17:1` 全部通过；用户已于 2026-11-20 在本地启动预览环境完成人工验收。

**已接受的代价与长期约束**

- `outdentTocEntry` 语义变更为保序收编后续兄弟，且 `TocPanel` 单击由「直接改名」改为「跳转定位」（改名改由双击、`F2` 或菜单触发），相关单测与 E2E 契约已同步更新。
- 自动注入正文 `id` 通过 `XmlCodec` 序列化写回受影响章节，依赖 XML 良构往返与 50 步目录撤销栈保障可回退性；生成扫描仅在打开 `TocGenerateDialog` 或触发标题刷新时按需执行，避免常态浏览 177+ 项长目录产生额外解析开销。
- `TocGenerateDialog` 复用默认 `Dialog` 内边距骨架并采用 `.dialog.toc-gen-dialog { width: min(680px, calc(100vw - 32px)); }`（不套用面向 `1100×760` 分栏快照的 `.dialog-wide`）。
