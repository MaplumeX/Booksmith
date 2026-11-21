# ADR: Code mode productivity toolbar, zero-dependency XHTML/CSS formatter, editor context menu, and Cmd+K command palette

Status: implemented

## Problem

在补齐章节拆分、合并与资源管理（见 [章节结构与资源工具决策](2026-11-21-chapter-structure-and-resource-tools.md)）后，代码编辑区仍存在三类高频效率与可发现性缺口：

1. **代码模式缺少快捷语义编辑与格式化**：选中文本套 `<h1>`–`<h4>`、`<p>`、`<strong>`/`<em>`、`<blockquote>`、`<ul>`/`<ol>`、插 `id` 锚点、插书内图片/链接/分隔线或特殊排版符号全靠手敲 XHTML；压缩或缩进混乱的 XHTML/CSS 无法一键整理。
2. **新增结构与编辑动作分散、可发现性弱**：仅靠快捷键或右键菜单对不熟悉 Sigil 快捷键的用户不够友好，但在主编辑区堆叠多层常驻图标栏又会破坏 [Soft Craft Studio 设计系统](../design/2026-11-20-soft-craft-studio-ui.md) 的无框纸面感。
3. **缺少统一的全局命令入口**：随着拆章、合章、样式表关联、清理资源、格式化、元数据、目录生成、查找替换与 AI 助手功能增多，需要一个键盘优先的全局命令面板把高频与进阶命令统一收口。

## Decision

在 `@booksmith/core` 新增零依赖 XHTML & CSS 格式化器，并在 `apps/web` 以「可收起单行轻量工具条 + 代码区右键菜单 + 全局命令面板」三层克制入口承载代码效率与全书命令，同时统一按操作系统检测展示原生快捷键文案。本决策建立在 [章节结构与资源工具决策](2026-11-21-chapter-structure-and-resource-tools.md) 之上并遵循 [Soft Craft Studio 设计系统](../design/2026-11-20-soft-craft-studio-ui.md)。

### 1. 零依赖 XHTML & CSS 格式化器（`@booksmith/core`）
- **`formatXhtml(xhtml, codec)`（[formatCode.ts](../../../../packages/core/src/formatCode.ts)）**：先校验 XML 良构性（破损 XML 拒绝格式化并给出明确错误提示）；2 空格缩进，完整保留 `<?xml?>`、`<!DOCTYPE>`、注释与 CDATA；仅对纯块级容器换行缩进，含文本或行内子节点的块视为行内流紧凑输出，绝不私自增删行内空白；严格原样保护 `<pre>`、多行 `<code>`、`<textarea>`、`<script>`、`<style>`、`<math>`、`<svg>` 内部字节；保持原文件主导行尾（`\r\n` / `\n`）。
- **`formatCss(css)`**：纯 TypeScript 词法格式化，正确处理引号字符串、`/* ... */` 注释、`url(...)` 及嵌套 `@media`/`@supports`/`@font-face`/`@page` 块，2 空格缩进并保留主导行尾。
- 仅格式化当前激活文件，在 [CodePane.tsx](../../../../apps/web/src/ui/CodePane.tsx) 中通过附带 `isolateHistory.of('full')` 的单个 CodeMirror Transaction 写回，确保即便紧跟打字后立即格式化，按一次撤回也只撤回格式化本身。

### 2. 代码模式编辑原语、可收起单行工具条与按系统适配的快捷键提示（`apps/web`）
- **单事务编辑原语（[codeActions.ts](../../../../apps/web/src/editor/codeActions.ts)）**：支持块级包裹/转换（`p`/`h1`–`h4`/`blockquote`）、行内包裹/切换（`strong`/`em`/`code`/`sup`/`sub`）、多行转 `<ul>`/`<ol>`、插入/更新 `id` 锚点、插入 `<a href>` / `<img src alt />` / `<hr />` / 常用特殊字符（[specialChars.ts](../../../../apps/web/src/editor/specialChars.ts)，分 4 组涵盖中文标点、破折号与空白、出版注释与数学希腊符号），全部以独立撤销分组的单事务应用。
- **单行工具条（[CodeToolbar.tsx](../../../../apps/web/src/ui/CodeToolbar.tsx)）**：位于 `TabBar` 下方，高度 `34px`，无多余外框，仅在代码模式且 `settings.showCodeToolbar === true`（默认开启，可在 [SettingsDialog.tsx](../../../../apps/web/src/ui/SettingsDialog.tsx) 的「设置 → 通用 → 编辑器」关闭，持久化于 [settingsStore.ts](../../../../apps/web/src/state/settingsStore.ts)）时渲染。XHTML 展示拆章/包裹/插入/格式化，CSS/XML 仅展示格式化与命令面板触发器；特殊字符、锚点、链接与图片选择使用按需 Radix Popover 浮层。
- **平台自适应快捷键提示（[shortcuts.ts](../../../../apps/web/src/editor/shortcuts.ts)）**：检测浏览器所在操作系统，在 macOS 上统一渲染 `⌘↩` / `⌥⇧F` / `⌘K` 等字形，在 Windows/Linux 上统一渲染 `Ctrl+Enter` / `Alt+Shift+F` / `Ctrl+K`，消除全站顶栏、工具条、右键菜单、可视化工具栏、目录栏与命令面板中的混用提示。

### 3. 代码区右键菜单与全局命令面板
- **代码区右键菜单**：在 [CodePane.tsx](../../../../apps/web/src/ui/CodePane.tsx) 上挂载 Radix `ContextMenu`，包含在光标处拆分、插入拆分标记、按标记拆分、包裹常用标签、关联样式表、美化格式化代码，以及有选区时的「全书查找选中内容」（经由 [SearchPanel.tsx](../../../../apps/web/src/ui/SearchPanel.tsx) 的 `initialQuery` 预填）。
- **全局命令面板（[CommandPalette.tsx](../../../../apps/web/src/ui/CommandPalette.tsx)）**：居中浮层（`width: min(560px, calc(100vw - 32px))`），在主窗口（[Editor.tsx](../../../../apps/web/src/routes/Editor.tsx)）及可视化 iframe 内（[WysiwygPane.tsx](../../../../apps/web/src/ui/WysiwygPane.tsx) 转发 `'command-palette'`）均可按 `Mod+K` 唤起，聚合「章节与结构 / 代码编辑 / 视图与面板 / 书籍工具」全部动作，支持中英文关键词过滤、方向键与回车执行、右侧 `<kbd>` 快捷键展示、不可用项置灰说明与无命中空态。所有组件已登记至 [DESIGN.md](../../../../DESIGN.md)。

## Alternatives considered

**引入 `prettier`（standalone + html/css 插件）做代码格式化。** 会为浏览器 bundle 引入约 500KB+ 额外体积，且 Prettier 的 HTML 解析器默认会重排自闭合标签与属性大小写，容易破坏严格 EPUB XHTML 与 MathML 结构。

**不提供代码工具条，仅靠快捷键与命令面板。** 虽然节省 34px 垂直高度，但对刚从 Sigil 迁移过来、习惯点击图标完成拆章/套标题/插符号的用户上手门槛过高；改为可随时在设置中关闭的 34px 轻量单行条兼顾两类用户。

**Sigil 式常驻多层图标工具栏。** 在 Booksmith 现有 52px 顶栏 + TabBar 下方再叠加多层常驻工具栏会严重压缩书稿编辑视野，违背 Soft Craft Studio 无框透气原则。

## Consequences

**交付与验收实测（2026-11-21）**

- `pnpm typecheck && pnpm build`：全仓 3 个包类型检查与构建通过（`apps/web` 2329 modules）。
- `pnpm test`：36 个测试文件、305 条单元测试全绿（含 `formatCode.test.ts` 对真实 MathML 书稿全量章节的幂等与文本零损校验、`codeActions.test.ts`、`shortcuts.test.ts` 与 `settingsStore.test.ts`）。
- `pnpm e2e`：[code-tools.spec.ts](../../../../e2e/code-tools.spec.ts)（3/3）及全部受影响 6 份套件 25/25 通过（`code-tools` / `structure` / `editor` / `undo` / `settings` / `wysiwyg`）；`node e2e/audit-shots.mjs` 输出 `audit: clean`；用户已于 2026-11-21 完成本地界面验收并确认跨平台快捷键展示修正。
- **已知范围外遗留**：既有旧用例 `e2e/panels.spec.ts:48`（TOC 单击改名）为前序目录增强改动遗留，按 `Not in scope` 保持未改。

**已接受的代价与长期约束**

- XHTML 格式化器通过“将含非空白文本或行内子节点的块视为行内流整体输出”避免破坏中英文词间空格与行内标签紧邻语义；若某块内部手工书写了跨行混排，格式化仅调整外层缩进而不强行拆合该块内部行内流。
- `CodePane` 挂载 Radix `ContextMenu` 会接管画布右键菜单，剪贴板操作仍可通过键盘快捷键（`Mod+C` / `Mod+V` / `Mod+X`）正常完成。
- 所有新增交互的快捷键文案须统一经由 [shortcuts.ts](../../../../apps/web/src/editor/shortcuts.ts) 的 `formatShortcut` 生成，禁止在 UI 组件中硬编码 `⌘`、`⌥` 或 `Ctrl/Cmd`。
