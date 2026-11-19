# ADR: EPUB editor MVP — code-first editing with server-side versions

Status: implemented

## Problem

要做一款"类似 Sigil"的 EPUB 编辑器。但 Sigil 在 0.9.15 就删除了 WYSIWYG 的 Book View，
改为代码视图 + 预览，可视化编辑被拆成独立的 PageEdit；到 2.6 它仍在加无障碍属性编辑、
校验与预览相关能力。也就是说"像 Sigil"在 2026 年不等于"所见即所得"，而是"比 Sigil 更
顺手的代码级编辑"。

同时使用者排除了两个常见差异点：**不做中文排版规则引擎**（认为排版不是差异点），
**不做富文本编辑**。因此产品的价值必须落在编辑体验本身与书库管理上，而不是排版智能。

目标书提供了功能底线：EPUB 3.0、25 章、`nav.xhtml`（177 项，三层嵌套，标题内嵌
`<math>`）与 `toc.ncx` 同时存在、目录锚点使用中文 id、20 张图片、pandoc 生成。
不能打开并正确编辑这本书的功能都不算 MVP。

## Decision

交付的是"打开一本书、改完、存回去、改坏了能退回"的闭环：

- **文件树**：按 Text / Styles / Images / Other 分组，Text 组按 spine 顺序排列，重名文件
  显示完整路径 tooltip，脏文件带圆点，`240px` 定宽，`<1024px` 收成抽屉。
- **代码编辑**：CodeMirror 6（`lang-html` / `lang-css` / `lang-xml`），多 tab、脏标记、
  行号、可换行；`ch010.xhtml`（174KB）打开与输入无卡顿。
- **实时预览**：`srcdoc` 注入 iframe，`300ms` 防抖；资源（图片、字体）转 blob URL，样式表
  内联并重写其 `url()`；渲染书的 CSS 与 MathML；滚动位置按比例保留。**只预览当前章。**
- **全书查找**：`core.searchBook` 扫描所有文本文件，支持正则与区分大小写，结果按文件分组，
  点击跳转到对应行并聚焦编辑器。
- **当前文件替换**：复用 `@codemirror/search` 的 ⌘F 面板（含 replace all）。
- **元数据面板**：编辑 `dc:title / creator / language / identifier / publisher / date /
  description / subject / rights`，写回时只重写这些 `dc:*` 节点，保留 `unique-identifier`、
  manifest、spine 与 `refines` 关系；多作者增删会同步清理对应 `refines` meta。
- **目录面板**：以 `nav.xhtml` 为主，改名/上移/下移/删除后同步 `toc.ncx`（重建 navMap，
  playOrder 递增）；标题里的内联 MathML 原样保留；锚点失效项单独标记。
- **资源导入**：图片/字体进 `EPUB/media/`，追加 manifest item（id 冲突自动加后缀）。
- **新建空白书**：`core.createEmptyEpub` 产出通过结构自检的最小 EPUB 3（mimetype、
  container.xml、content.opf、nav.xhtml、一章正文、一份 CSS）。
- **版本**：每次保存生成版本，保留 20 版；右栏「版本」tab 列出历史并支持恢复。
- **书库**：封面墙，卡片显示「28 章 · 696 KB · 3 天前」，可搜索，超过 50 本再给列表切换。

保真规则（不可协商）：正文文件永远只做文本替换，绝不经过 DOM 往返；`OPF/nav/NCX` 是唯一
用 DOM 解析后定向序列化的文件；未修改的 zip 条目在原字节基础上重打包。

## Alternatives considered

**富文本所见即所得（contenteditable / ProseMirror）作为主编辑面**。命名空间、`epub:type`、
内联样式都会被富文本层改写，这恰是 Sigil 放弃 Book View 的原因；工作量是代码视图的 3–5 倍。
不采用。

**代码 + 独立可视化窗口（PageEdit 式双模）**。方向正确但属于第二阶段：先把"不破坏文件、
编辑顺"做扎实，再叠加可视化窗口。

**中文排版规范化引擎（首行缩进、标点挤压、中西文间距）**。曾被列为候选差异点，使用者在
Q7 明确否决：排版不是这个产品要解决的问题。放弃，同时不做自动改正文的任何默认行为。

**只做排版检查、不自动修改**。同上，随排版能力一起排除。

**接入 EPUBCheck**。它需要 Java 运行时，且校验报告与编辑器动作之间的桥接成本高；第一版
用 `core.validateStructure` 做结构自检（mimetype、container、OPF、spine/manifest 引用）。

**EPUB2 ↔ EPUB3 转换、插件系统、协作编辑**。都不在第一版的价值路径上，推迟。

## Consequences

**验收结果（2026-11-19）**

- 真实书：文件树 28 个 Text 文档、177 项目录、`ch003.xhtml` 打开含「序言」。
- 预览：`body` 的 `margin: 5%` 来自书的 CSS；`<math>` 有非零盒子；封面 `naturalWidth > 0`。
- 全书搜索「马克思」384 处 / 23 文件；正则 `第[一二三四五六七八九十]+章` 跨 16 章命中的标题。
- 元数据改名保存后刷新仍在；目录第 4 项改名后 nav 与 NCX 同步，177 项不丢，MathML 标题往返无损，
  真实书 0 个失效锚点。
- 保存 → v2 → 刷新可见；第二标签页保存触发 409；恢复后 v3 且内容等于源版本。
- 新建书 → 编辑 → 保存 v2；导入 PNG → 文件树出现 → 保存后重新加载仍在。

**未随本版交付**（原 Proposal 列出、实现时裁剪，均留在第二版）

- **全书连续预览**：右栏只渲染当前章，没有把 spine 串起来滚动阅读的模式。
- **`refines` / `meta` 折叠编辑**：表单只覆盖 `dc:*`，`role`、`dcterms:modified`、
  `ibooks:*` 等 `meta` 只能去 OPF 里手改。
- **目录增项与层级调整**：只能改名、上下移动、删除；新增条目和缩进/取消缩进没有入口。
- **导入资源后自动插入正文引用**：只写入 manifest 与 archive，`<img>` 由用户自己写。
- **版本 `pinned` 的界面**：存储与列表支持，没有标记/取消的 API 与按钮。

**代价与风险**

- 目录是全书结构里最脆弱的部分：pandoc 生成的嵌套 + 标题内联标记，任一处序列化差异都会
  被放大到 177 项。目前用往返断言守住，但没有 fuzz。
- 只有 EPUB3 真实样本；EPUB2 的 `toc.ncx` 编辑路径只有构造样本的单测覆盖。
- 版本快照按整包复制，20 版 × 2MB 尚可，200MB 的书会明显吃库。
- 预览重建 iframe 时靠比例恢复滚动位置，长章节可能有轻微跳动（只承诺 Chromium）。
