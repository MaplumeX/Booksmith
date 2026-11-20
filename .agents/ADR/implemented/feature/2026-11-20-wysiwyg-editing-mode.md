# ADR: WYSIWYG chapter editing mode

Status: implemented

## Problem

此前工作台仅支持基于 CodeMirror 6 的源码编辑与右侧只读预览（见 [the MVP editor decision](2026-11-19-epub-editor-mvp.md)）。编辑者在做文字润色、分段合并、标题调整与行内强调校对时，视线仍需在 XML 标签源码与右栏渲染之间反复跳转；而当时预留的"代码 + 独立可视化窗口（PageEdit 式双模）"尚未实现。

与此同时，EPUB 正文普遍携带 `<?xml?>` 声明、`<!DOCTYPE>`、`<head>` 样式表引用、`epub:type` 命名空间属性以及内联 MathML（`<math>`）。直接把整份 XHTML 交给常规富文本编辑器往返序列化，会改写头部声明、剥离命名空间或破坏公式结构。

## Decision

在保留代码模式为默认主编辑面的前提下，为可预览章节（`.xhtml` / `.html` / `.htm`）提供**主编辑区双模切换的所见即所得（WYSIWYG）校对模式**。本决策延续 [the MVP editor decision](2026-11-19-epub-editor-mvp.md) 预留的双模方向，并**局部放宽**其"正文文件永远只做文本替换，绝不经过 DOM 往返"规则：仅当用户在可视化模式下主动编辑某一章节时，对其 `<body>` 子树执行受控 XHTML 序列化写回。

### 核心架构与保真边界

- **工作区入口与全局偏好**：在 [TabBar.tsx](../../../../apps/web/src/ui/TabBar.tsx) 行右侧放置「代码 | 可视化」分段切换，作为编辑区全局模式偏好；切换至 `.css`、`.opf` 或图片等非页面条目时自动回落代码或媒体视图，切回章节时恢复偏好。
- **渲染与编辑内核**：复用 [render.ts](../../../../apps/web/src/preview/render.ts) 的 `buildPreview` 管线在沙箱 `iframe` 中载入书稿真实 CSS、字体、图片 Blob URL 与 MathML，将 `<body>` 设为受控 `contentEditable`（实现于 [WysiwygPane.tsx](../../../../apps/web/src/ui/WysiwygPane.tsx) 与 [wysiwygXhtml.ts](../../../../apps/web/src/editor/wysiwygXhtml.ts)）：
  - 入口先通过 `checkXmlWellFormed`（基于 `browserXmlParser`）校验 XHTML 良构性，语法破损的章节禁止进入可视化并提示切回代码模式修复。
  - 为 `<math>`、`<svg>`、`<video>`、`<audio>` 等复杂节点设置 `contentEditable="false"` 保护岛并在加载时采集原始 XML 子串快照，序列化时原样回填未修改保护岛，防止误删内部标签。
  - 为 `buildPreview` 重写的 `<img>` 记录 `data-booksmith-src` 与原始 `alt`（含缺图占位前的属性），写回时剥离 `blob:` URL 与编辑期临时属性（`contenteditable`、`data-booksmith-*`、`data-missing`）。
  - 写回通过确定性 XHTML 序列化器 `serializeEditableBody` 仅处理 `<body>...</body>` 区间（统一空元素自闭合如 `<br />`、`<img ... />` 并规避不同运行时 `XMLSerializer` 差异），再由 `replaceBodyInXhtml` 替换原 XHTML 字符串的对应区间，完整保留 `<?xml?>`、`<!DOCTYPE>`、`<head>` 与根节点命名空间声明。
- **校对级能力集**：通过 [wysiwygDom.ts](../../../../apps/web/src/editor/wysiwygDom.ts) 提供选区与 DOM 操控，支持正文直接输入/删改、回车分段（含标题末尾回车生成干净 `<p>`）与合并、段落/标题切换（`p` / `h1`–`h4`）、基础行内格式（`strong` / `em` / `code` / `sup` / `sub` / 清除格式）、链接锚点原地浮条编辑（点击 `<a>` 不跳转离开页面，支持改 `href`、跳转书内目标或移除）与插入书内图片（从已导入资源选择并自动计算相对路径）。
- **状态同步与撤销边界**：
  - 仅在用户实际发生输入或 DOM 格式修改（`hasPendingEdit`）时经 `300ms` 防抖写回 `texts` 映射，避免未编辑章节在关闭或切回代码时因换行符/标签闭合空白规范化而被误标为脏文件；真实修改后正常触发 `dirty`、本地草稿缓冲、自动保存、`StatusBar` 字数统计与全书查找。
  - 可视化内部维护独立细粒度快照撤销/重做栈（上限 50 步），并在 `iframe` 内捕获 `⌘B`/`⌘I`/`⌘Z`/`⌘⇧Z` 及向宿主转发 `⌘S`/`⌘W`/`Ctrl+Tab`/`⌘⇧F`。
  - 按 [the per-tab editor state decision](../bug-fix/2026-11-19-editor-state-per-tab.md) 保持 [CodePane.tsx](../../../../apps/web/src/ui/CodePane.tsx) 常驻隐藏而不卸载；从可视化切回代码时，以单个 CodeMirror Transaction 写回变更，使代码模式按一次 `⌘Z` / `Ctrl+Z` 即可整段撤回该轮可视化修改；全书替换、快照恢复与重命名则通过 `externalResetVersion` 仍按原规则重置状态。
- **画布质感**：遵循 [the precision workbench UI decision](../design/2026-11-20-precision-workbench-ui.md)，主区以 `--surface-sunken` 托底居中呈现限宽 `760px` 校对纸面，默认浅色纸底保证书稿颜色与插图保真，工具栏提供纸面明暗切换，并在 [DESIGN.md](../../../../DESIGN.md) 完成组件与五态登记。

## Alternatives considered

- **引入 ProseMirror / TipTap 作为富文本内核**：需维护覆盖任意 EPUB 标签、属性、`epub:type`、内联样式与 MathML 的庞大 Schema，且脱离书自带 CSS 渲染便偏离“所见即所得”，工程与维护成本成倍增加。
- **预览点选块级直改（不做自由富文本）**：虽可完全避免 DOM 往返，但无法支持跨段编辑、回车分段或行内格式切换，达不到所见即所得校对体验。
- **在右侧预览栏直接开启编辑（左右并排实时双编辑）**：右栏固定 `400–560px` 宽度过窄，不适合长文阅读校对，且会挤占目录/查找/检查面板空间。
- **按单文件记忆编辑模式**：连续校对多章时每打开一章都需要重复切换模式，增加操作摩擦。
- **切回代码时沿用全书替换机制重置 `EditorState`**：会清空代码侧原有撤销历史，失去切回代码后一键整段撤回可视化修改的安全网。
- **无保护岛直接放开全 `<body>` 编辑与暗色反色**：浏览器 `contentEditable` 在 `<math>`/`<svg>` 中按退格键极易删碎公式标签，强行暗色反色也会破坏书内已有配色规则。
- **仅在切回代码或保存时延迟写回 `texts`**：会导致可视化编辑期间自动保存、草稿恢复与全书查找感知不到最新文本。

## Consequences

**验收结果（2026-11-20）**

- `pnpm -r typecheck && pnpm -r build`：全部 3 个包类型检查与构建通过（`apps/web` 2301 modules）。
- `pnpm test`：18 个文件、190 条单元测试全部通过（含 `wysiwygXhtml.test.ts` 4 条与 `tokens.test.ts` 51 条对比度校验）。
- `pnpm exec playwright test`：全库 66 条端到端用例全部通过（含新增 [wysiwyg.spec.ts](../../../../e2e/wysiwyg.spec.ts) 6 条，覆盖居中纸面与书内 CSS 渲染、改字分段保存与刷新持久化、`<math>` 保护岛与非 `blob:` 图片 `src` 保真、切回代码单步 `⌘Z` 撤回、非良构 XML 拦截、以及未编辑章节关闭不标脏回归）。
- `node e2e/audit-shots.mjs`：输出 `audit: clean`；用户已在本地开发工作台完成目视与交互验收。

**代价与已知限制**

- 仅当章节在可视化模式下被实际编辑时，写回的 `<body>` 子树会做确定性 XHTML 规范化（例如 `\r\n` 转 `\n`、空元素统一为 `<br />` / `<img ... />`），首次在可视化编辑含旧格式差异的章节时会产生一定格式 diff。
- 表格行列增删、复杂列表嵌套重构与自定义 `class`/内联样式面板未纳入首版能力集，仍需切回代码模式处理。
- 并发外部重写（全书替换、版本恢复、文件重命名）在可视化模式下会刷新 `iframe` 并重置当前可视化快照撤销栈，与 `CodePane` 的外部重置边界保持一致。
