# ADR: Reader baseline typography and contrast-aware dark mode adaptation

Status: implemented

## Problem

在 [the Soft Craft Studio UI decision](2026-11-20-soft-craft-studio-ui.md) 与 [the WYSIWYG editing decision](../feature/2026-11-20-wysiwyg-editing-mode.md) 落地后，实时书页预览（`PreviewPane`）与所见即所得校对纸面（`WysiwygPane`）统一跟随全局浅/深色主题，但书籍正文的实际渲染仍存在两类突出问题：

1. **基础排版样式缺失**：`buildPreviewThemeCss` 与 `buildEditorStyleCss` 仅设置了 `body` 背景/文字色、链接色和少量边框色，缺少对段落、标题、引用块（`blockquote`）、代码块（`pre`/`code`）、表格（`table`/`th`/`td`）、列表、题注（`figcaption`）、注脚上标（`sup`/`sub`）与分隔线的阅读基线；当 EPUB 自带 CSS 未覆盖这些元素时，直接退化为浏览器默认样式，且预览栏缺少保底内边距。
2. **暗色模式下书籍自有颜色导致低对比或不可读**：许多 EPUB 的样式表或行内 `style` 写死了浅色背景下的颜色（例如 `blockquote { color: #555 }` / `#666`、深灰字或浅灰底块 `#f5f5f5`）。暗色模式仅在 `html, body` 上设置 `#1a1b24` 底色与 `#ececf2` 继承字色，无法压过原书规则与行内 `style`，导致夜间模式下引用块呈暗灰近乎不可见，或出现浅底配浅字的对比度失效；同时切换全局主题时，已加载文档的书籍 CSS 与行内颜色未就地重算。

## Decision

在保留"全站统一跟随全局主题"与"所见即所得不抢占原书 CSS 设计意图"的前提下，对预览与可视化共享的渲染管线（[render.ts](../../../../apps/web/src/preview/render.ts)）实施两层增强，受 [the Soft Craft Studio UI decision](2026-11-20-soft-craft-studio-ui.md) 与 [the WYSIWYG editing decision](../feature/2026-11-20-wysiwyg-editing-mode.md) 约束：

### 1. 零权重阅读基线样式表（`:where(...)` Reader Baseline）

- 在 `<head>` 最前方（早于书籍 `<link>` 与 `<style>`）注入 `data-booksmith-base-style` 样式表（`buildReaderBaseCss`），全部元素选择器包裹在零特异性的 `:where(...)` 中：
  - **排版与流式适配**：设置中英文阅读字体栈、行高 `1.72`、段落间距、标题 `h1`–`h6` 字号与行高阶梯、列表缩进、`img, svg, video { max-width: 100%; height: auto; }`、`sup`/`sub` `line-height: 0`（防止脚注撑裂行距）及 `math[display="block"]` 垂直间距（保留浏览器原生 `block math` 布局与 `overflow: visible`，避免公式上下出现滚动条）；为 `PreviewPane` 提供 `:where(body)` 安全内边距（`20px 24px`）与 `margin: 0` 兜底。
  - **结构块样式与对比度**：复用 Soft Craft Studio 语义色阶，为未定义样式的 `blockquote`（`3px` 左侧竖线、`#f4f4f6` / `#222430` 衬底、`#464655` / `#b4b5c7` 文字，实测对比度 `8.43:1` / `7.61:1`）、`pre`/`code`（`#f4f4f6` / `#222430` 表面 + `1px` 细边框、`#202028` / `#ececf2` 文字，实测 `14.72:1` / `13.09:1`）、`table`/`th`/`td` 与 `figcaption`（`#5a5a6b` / `#9e9fb3`，实测 `>= 5.92:1`）提供统一阅读基线。
- 抽取 `buildSharedOverlayCss` 统一 `PreviewPane` 与 `WysiwygPane` 的缺图占位（`img[data-missing="true"]`）与拆分标记（`hr.sigil_split_marker`）样式，消除 `buildPreviewThemeCss` 与 `buildEditorStyleCss` 重复规则。

### 2. 基于亮度与对比度的暗色色彩自适应

- 新增 [darkThemeColor.ts](../../../../apps/web/src/preview/darkThemeColor.ts)，解析 CSS 声明与行内 `style` 中的 `#hex`、`rgb/rgba`、`hsl/hsla` 及标准 CSS 命名色，仅在暗色模式下对原书 CSS 规则及 `<body>` 内联 `style` 执行适配（跳过 `math` / `svg` / `video` / `audio` 保护岛内部与 `url(...)` / `var(...)`）：
  - **前景色（`color`、`text-decoration-color` 等）**：若在暗色抬升表面 `#222430` 上对比度低于 `4.5:1`，低饱和中性暗灰/黑映射至暗色文字阶（`#ececf2` / `#b4b5c7` / `#9e9fb3`）；带明显色相的深色保持色相并提亮至满足 `>= 4.6:1`。
  - **背景色（`background-color` / `background` 纯色声明）**：忽略透明色与 `url(...)` 纹理；高亮度中性浅底映射至暗色表面阶（`>= 0.96` 映射 `#1a1b24`，`0.65–0.96` 如 `#f5f5f5` 映射 `#222430`，`0.22–0.65` 映射 `#282a38`），淡彩底块保留色相并压暗至低明度深底。
  - **边框色（`border*`、`outline*`）**：过亮或过暗的中性边框收敛到 `#2c2e3d` / `#464655`。
- **可视化写回零污染**：`editable` 模式下 `adaptDocumentBodyInlineStyles` 在修改元素行内 `style` 前将原值存入 `data-booksmith-orig-style`，[wysiwygXhtml.ts](../../../../apps/web/src/editor/wysiwygXhtml.ts) 序列化时按原属性还原并剔除 `data-booksmith-orig-style`。
- **动态主题切换就地同步**：切换浅/深色主题时，[PreviewPane.tsx](../../../../apps/web/src/ui/PreviewPane.tsx) 与 [WysiwygPane.tsx](../../../../apps/web/src/ui/WysiwygPane.tsx) 就地重跑样式与行内颜色适配（在可视化模式执行撤销/重做后也同步对齐当前主题），不重载 `iframe`。

## Alternatives considered

- **纯 CSS `!important` 统一覆写常见标签颜色**：实现更简单，但会无差别抹平书籍本身有意义的彩色强调或语义标注，也无法修复带浅色背景块的盒子或复杂内联 `style`。
- **高优先级阅读器主题样式覆盖书籍排版**：强行统一全书字体、字号和段落缩进虽外观更一致，但会让编辑者调试书籍自身 CSS 时预览失真，违背所见即所得初衷。
- **在「设置」中新增「书页始终浅色」开关或回退纯白预览纸面**：能避开暗色渲染缺陷，但无法满足夜间模式下舒适校对与阅读的核心需求，且新增无必要的状态分支。

## Consequences

**验收结果（2026-11-21）**

- `pnpm -r typecheck && pnpm -r build`：全部 3 个包类型检查与生产构建通过（`apps/web` 2330 modules）。
- `pnpm test`（`vitest run`）：37 个测试文件、315 条单元测试全部通过（含 `darkThemeColor.test.ts` 7 条、`render.test.ts` 9 条、`wysiwygXhtml.test.ts` 6 条及 `tokens.test.ts` 53 条对比度与刻度守卫）。
- `pnpm exec playwright test`：覆盖本变更的 `preview.spec.ts`、`wysiwyg.spec.ts`、`settings.spec.ts` 与 `agent.spec.ts`（配置 `AGENT_SECRET_KEY` 后重跑）全部通过（全库 92 条中 91 条通过；`e2e/panels.spec.ts:43` 存在既有基线用例问题——`TocPanel.tsx` 重命名需双击而旧用例仍单击 `.toc-label`，未在本次改动范围内）。
- `node e2e/audit-shots.mjs`：输出 `audit: clean`（`1440px`、`400px` 与暗色模式零横向溢出、零断图、零报错）。

**代价与已知限制**

- 颜色自适应通过轻量扫描器解析 CSS 声明与内联 `style`，对嵌套 CSS 自定义属性（`var(--custom)`）或复杂渐变内部色标不做展开替换；遇到未知表达式时保持原值不变。
- 可视化模式在切换主题后执行撤销/重做时，会立即将恢复的快照内联 `style` 重新对齐至当前全局主题，以防止历史快照携带旧主题颜色。
