# ADR: Chapter split, merge, duplicate, stylesheet linking, unused resource cleanup, and agent structure tools

Status: implemented

## Problem

[文件结构编辑决策](2026-11-19-file-structure-editing.md) 交付了章节新建、改名、删除与上下移，但在整理真实 EPUB 书稿（例如合并导入的长稿、转档后的单章大文件、带大量历史遗留资源的书）时仍缺少 Sigil 风格的核心结构操作：

1. **无法拆分章节**：缺少在光标处拆分（Split at Cursor）与按拆分标记批量拆分（Split at Markers），作者只能手动复制全文、删前删后、手改 OPF `<spine>`，且跨章 `#id` 锚点与目录链接极易断裂。
2. **无法合并与复制章节**：文件树只支持单选操作，无法把碎章合并进上一章或批量合并多选章节，也不能一键复制现有章节模板。
3. **样式表与未引用资源管理割裂**：文件树无法新建空白 CSS，也没有弹窗批量勾选章节关联的 `<link rel="stylesheet">`；结构检查虽能发现 `unused-resource`，却没有批量清理入口。
4. **缺少结构级撤销与 AI 助手结构工具**：多文件结构变更一旦手滑误操作，只能逐个文件恢复或退回已保存版本；[内置 AI 助手](2026-11-20-builtin-epub-agent.md) 缺少按标题拆章、合章、挂载样式表与清理未引用资源的专用原子工具。

## Decision

在 `@booksmith/core` 构建前后端同构的章节结构与资源管理纯函数内核，在浏览器端提供代码/可视化双模拆章、文件树多选与结构弹窗、20 步工作区结构撤销栈，并同步向内置 AI 助手开放 5 个对应结构工具。本决策遵循 [Soft Craft Studio 设计系统](../design/2026-11-20-soft-craft-studio-ui.md)、[文件结构编辑决策](2026-11-19-file-structure-editing.md)、[可视化校对模式决策](2026-11-20-wysiwyg-editing-mode.md) 与 [内置 AI 助手决策](2026-11-20-builtin-epub-agent.md)。

### 1. Sigil 兼容拆分标记、严格良构拆章与锚点级引用迁移（`@booksmith/core`）
- **拆分标记与命名**：采用 Sigil 兼容标记 `<hr class="sigil_split_marker" />`（[chapterSplit.ts](../../../../packages/core/src/chapterSplit.ts)），在对照预览与可视化模式（[render.ts](../../../../apps/web/src/preview/render.ts)）中渲染专属虚线横幅（「✂ 拆分点」），并在 [lint.ts](../../../../packages/core/src/lint.ts) 中增加 `pending-split-marker` 提醒防止忘记执行拆分而误导出。新章节按源文件名顺延命名（如 `ch001.xhtml` → `ch001_0001.xhtml`、`ch001_0002.xhtml`，自动避让已存在路径），并通过 `insertSpineDocumentsAfter`（[opfEdit.ts](../../../../packages/core/src/opfEdit.ts)）紧插在源章节之后的 `<spine>` 位置。
- **严格良构拆章**：`splitXhtmlAtOffset` / `splitXhtmlAtMarkers` / `splitXhtmlByHeadingLevel` 要求输入章节为良构 XML（破损 XML 拒绝拆分并返回明确提示）；切分点若落在标签内或 `<math>`/`<svg>`/`<video>`/`<audio>`/注释/CDATA 保护区内部，自动对齐至安全边界而非撕裂结构；基于 XML 标签栈闭合前半部分未闭祖先标签，在后半部分按原属性重开并自动移除重复 `id`/`xml:id` 属性；完整继承 XML 声明、`<!DOCTYPE>`、`<html>` 命名空间、`<head>` 与原文件主导行尾（`\r\n` / `\n`），并在返回前二次校验产物 XML 良构性。
- **跨章 `#id` 引用迁移**：`collectDocumentIds` 与 `rewriteAnchorReferences`（[references.ts](../../../../packages/core/src/references.ts)）在全书文本文件（含各章 `<a href>`、`nav.xhtml`、`toc.ncx`）中按 `(sourcePath, id) -> targetPath` 精准改写指向被拆出锚点的链接（包括同文件 `#id` 改写为跨文件相对路径，以及新章节中指向留守锚点的 `#id` 反指源章节），保持未受影响字节零改动。

### 2. 合并章节、复制章节、样式表管理与未引用资源清理（`@booksmith/core`）
- **合并章节（[chapterMerge.ts](../../../../packages/core/src/chapterMerge.ts)）**：`mergeChaptersInBook` 支持「与上一章合并」及文件树多选按 spine 阅读顺序合并。保留首章为主文件，依次拼入后续章节 `<body>` 内容（跨目录时自动重算相对引用）并补齐后续章独有的 `<link rel="stylesheet">`；将全书与目录指向被合并章节的链接（含裸链接与 `#id` 锚点）重写至主文件，对被裸链接指向的被合并章自动确保起始锚点可定位，随后从 manifest、spine 与 archive 移除已吸收文件。
- **复制章节**：`duplicateChapterInBook` 克隆当前章节并在 spine 紧后插入（如 `ch001_copy.xhtml`）。
- **样式表管理与未引用资源清理（[stylesheets.ts](../../../../packages/core/src/stylesheets.ts)）**：提供 `listBookStylesheets`、`getLinkedStylesheets`、`setChapterStylesheets`、`updateChaptersStylesheets`（仅增删 `<head>` 内 `<link rel="stylesheet" />`，保留其余 `<head>` 节点与主导行尾）与 `createBlankStylesheet`（创建 `.css` 并注册至 manifest，不进入 spine）；`findUnusedResources` 分类扫描未被引用的图片、字体与未关联样式表，自动排除 OPF 自声明、spine 文档、EPUB 3 `properties="cover-image"` 与 EPUB 2 `<meta name="cover">` 封面图，由 `deleteUnusedResourcesInBook` 原子移除。

### 3. 双模编辑体验、文件树多选与 20 步工作区结构撤销栈（`apps/web`）
- **双模拆章一致**：代码模式（[CodePane.tsx](../../../../apps/web/src/ui/CodePane.tsx)，通过 [eol.ts](../../../../apps/web/src/editor/eol.ts) 的 `mapLfOffsetToSource` 精确对齐 CRLF 偏移）与可视化模式（[WysiwygPane.tsx](../../../../apps/web/src/ui/WysiwygPane.tsx)）均支持 `Mod+Enter`「在光标处拆分」与 `Mod+Shift+Enter`「插入拆分标记」；可视化工具栏提供对应按钮，光标处拆分通过在 DOM 选区插入临时哨兵并序列化后复用 `@booksmith/core` 同一套拆分内核。
- **20 步工作区结构撤销栈（[structureHistory.ts](../../../../apps/web/src/state/structureHistory.ts)）**：拆章、按标记批量拆分、合章、复制章、批量关联样式表、清理未引用资源均原子压入 `WorkspaceSnapshot` 撤销栈，并在 [Editor.tsx](../../../../apps/web/src/routes/Editor.tsx) 底部弹出带「撤销」按钮的轻提示 Toast，一键还原全部文件、OPF、目录、标签页与基线脏状态（所有变更统一经 `syncDirtyFromBaseline` 与 `syncDurability` 同步）。
- **结构弹窗与文件树多选**：提供 [LinkStylesheetsDialog.tsx](../../../../apps/web/src/ui/LinkStylesheetsDialog.tsx)（`480px`，多章支持三态半选与弹窗内新建 CSS）与 [UnusedResourcesDialog.tsx](../../../../apps/web/src/ui/UnusedResourcesDialog.tsx)（`560px`，分类勾选、体积汇总与图片缩略图）；[FileTree.tsx](../../../../apps/web/src/ui/FileTree.tsx) 的 Text 组支持多选与顶部批量操作栏（合并选中章节 / 关联样式表），右键菜单提供拆合/复制/样式表操作，Styles 组支持新建空白 CSS；[CheckPanel.tsx](../../../../apps/web/src/ui/CheckPanel.tsx) 将 `pending-split-marker` 归为提醒组并在存在未引用资源时提供清理入口。所有组件已登记至 [DESIGN.md](../../../../DESIGN.md)。

### 4. 内置 AI 助手结构工具（Core + Server + Web）
- 在 [agentTools.ts](../../../../packages/core/src/agentTools.ts)、[runner.ts](../../../../apps/server/src/agent/runner.ts)、[systemPrompt.ts](../../../../apps/server/src/agent/systemPrompt.ts) 与 [AgentPanel.tsx](../../../../apps/web/src/ui/AgentPanel.tsx) 注册 5 个原子结构写工具：`split_chapter`（支持行号 / 锚文本 / 拆分标记 / 按 `h1`–`h6` 标题级拆分）、`merge_chapters`、`link_stylesheets`、`create_stylesheet`、`cleanup_unused_resources`（总工具数 16 → 21），沿用结构提案 Diff 审阅、结构预检与自动降级机制。

## Alternatives considered

**使用 HTML 注释 `<!-- booksmith:split -->` 作为拆分标记。** 虽在未拆分直接导出时对阅读器不可见，但在可视化编辑模式下无法直观呈现和选中删除，也不能与 Sigil 互通，故选用 Sigil 标准 `<hr class="sigil_split_marker" />` 并辅以 `lintBook` 提醒兜底。

**纯文本正则硬切并宽松补齐闭合标签，不自动迁移 `#id` 引用。** 虽可容忍暂时破损的 XML，但在嵌套同名 `<div>`、注释或 MathML 场景下极易破坏文档结构，且拆章后会造成目录和脚注锚点大面积断链，不可接受。

**仅提供单步结构撤销或不提供结构撤销。** 连续拆分多章或批量清理资源后若需回退多步，单步撤销或退回版本历史摩擦极大；复用 `WorkspaceSnapshot` 构建 20 步内存撤销栈成本极低。

**仅在代码模式支持拆章，可视化模式不支持。** 校对阅读时随手拆章是高频需求，通过临时 DOM 哨兵复用同一份核心拆分引擎，无需重复维护两套拆分逻辑。

**本期不将结构工具接入内置 AI 助手。** 既然核心引擎已在 `@booksmith/core` 纯函数化，同步包装给 `AgentWorkspace` 即可让用户直接通过对话完成「按一级标题拆章」「批量合并并挂样式表」等高价值批量任务。

## Consequences

**交付与验收实测（2026-11-21）**

- `pnpm typecheck && pnpm build`：全仓 3 个包类型检查与构建通过（`apps/web` 2329 modules）。
- `pnpm test`：36 个测试文件、305 条单元测试全绿（含 `opfEdit`、`references`、`chapterSplit`、`chapterMerge`、`stylesheets`、`lint`、`agentTools`、`structureHistory` 与 `tokens` 对比度测试，以及真实 MathML 书稿拆分验证）；`pnpm --filter @booksmith/server test`：7 个文件、68 条服务端集成测试全绿。
- `pnpm e2e`：[structure.spec.ts](../../../../e2e/structure.spec.ts)（4/4）与 [agent.spec.ts](../../../../e2e/agent.spec.ts)（1/1）及全量回归 86/87 通过；`node e2e/audit-shots.mjs` 输出 `audit: clean`；用户已于 2026-11-21 在本地开发工作台完成人工体验验收。
- **已知范围外遗留**：既有旧用例 `e2e/panels.spec.ts:48`（TOC 单击改名）与此前目录增强决策将单击改为跳转的既定行为不符，本次按 `Not in scope` 保持未改，待后续单独修正。

**已接受的代价与长期约束**

- 核心拆分/合并算法直接对源 XML 字符串做精准切片与标签栈闭合，仅在良构校验与 OPF/TOC 更新时调用 `XmlCodec`，避免 `browserXmlCodec` 与 `@xmldom/xmldom` 的序列化差异引入多余 diff。
- 光标若落入 `<math>` / `<svg>` / `<video>` / `<audio>` 保护岛内部，拆分点自动对齐至保护岛之前，确保公式与矢量图绝不被截断。
- 多章合并若遇到两章原本就存在同名 `id`，保留原文 `id` 不静默改写，避免破坏既有样式选择器或脚本约定。
- 后续扩展：[文件树全分组多选与批量操作决策](2026-11-26-filetree-batch-operations.md) 将文件树多选从 `TEXT` 组扩展至全分组跨组多选，升级为两行吸顶批量栏，并补齐批量重命名、批量删除、非连续章节批量移序与容器文件保护。
