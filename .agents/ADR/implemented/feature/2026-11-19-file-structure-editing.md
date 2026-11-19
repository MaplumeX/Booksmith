# ADR: File structure editing — create, rename, delete, reorder

Status: implemented

## Problem

编辑器能改文件内容，不能改书的结构。`apps/web/src/ui/FileTree.tsx` 的右键菜单只有「版本历史」，
文件树对一个 EPUB 编辑器和对一个文本查看器是一样的。三条具体缺失：

- 无法新建章节。新建空白书只有 `create.ts` 产出的那一章，之后想加一章必须去手改 OPF 的
  `manifest` 与 `spine`，还要自己写 XHTML 骨架。
- 无法重命名或删除条目。重命名 `text/ch003.xhtml` 需要同时改 OPF 的 `manifest href`、
  `nav.xhtml`/`toc.ncx` 的目录 `href`，以及正文里所有指向它的 `<img src>`、`<a href>`、
  `<link href>`。少改一处就留下静默断链——在预览里表现为空白图，用户会以为书坏了。
- 无法调整阅读顺序。`bookStore.groupFiles` 按 spine 排 Text 组，顺序来自 OPF 的
  `<itemref>`，但全库没有写 `<spine>` 的代码，改顺序只能去改 XML。

`packages/core` 现状：只有 `addManifestItem`（追加 manifest item，不碰 spine），没有删除、
改名或重排。`path.ts` 已有 `dirname` / `resolvePath` / `splitFragment`，是引用解析的现成地基。

## Decision

**四个操作，一份引用改写。**

- **新建章节**：写最小 XHTML 骨架（`xmlns`、`epub:type="chapter"`、`<title>`、空 `<body>`）
  → `addSpineDocument` 追加 manifest item 与 `<itemref>` 到 spine 末尾。**不动目录**：目录是
  编辑者手工决定的结构，自动塞一条「新章节」只制造待清理的噪声。
- **重命名**：改 manifest 的 `href`；按旧路径解析所有引用的目标路径，命中则重写为正确的相对
  路径（`relativePath` 反算，保留 fragment）；同步 `nav.xhtml` / `toc.ncx` 的条目 `href`；
  迁移 `texts`、`tabs`、`dirty`、`entries` 里的路径键。
- **删除**：从 manifest 删 item、从 spine 删其 `itemref`、从目录删指向它的条目（留着必然失效）；
  若仍有正文引用，先列出「文件 + 行号 + 引用文本」再要求二次确认，确认后引用留在原处由用户修。
- **重排**：文件树 Text 组右键「上移 / 下移」，重写 `<spine>` 的 `<itemref>` 顺序。

**引用匹配靠路径解析，不靠字符串。** `collectReferences` 对每个文本文件用 `resolvePath(dirname(file), href)`
算出目标归档路径；`rewriteReferences` 只改目标路径命中的那些，再用 `relativePath` 从引用者所在
目录反算新写法。这样 `ch003.xhtml` 不会误伤 `appendix-ch003.xhtml`，跨目录的 `../images/x.png`
也能正确重算。

**扫描范围**：`href`、`src`、`xlink:href` 属性，以及 CSS 里的 `url(...)`（相对 CSS 文件自身目录解析）。
不解析 `srcset`、不解析 XHTML 内联 `<style>` 之外的动态字符串——它们不是 EPUB 结构引用。

## Alternatives considered

**只改 OPF，不动正文引用。** 代码最少，成本从 L 降回 M。但重命名一章会静默断开 20 张图的
`src`，且在预览里表现为「图没了」，用户无从判断是书坏了还是编辑器改坏了。这是数据损坏级的
行为，不接受。

**引用改动用字符串替换（把旧文件名直接 replace 成新的）。** 实现最省事，但会误伤
`appendix-ch003.xhtml` 这类包含子串的路径，也会把正文文字里出现同名文件名的地方一起改。
路径解析是唯一正确做法，多出的成本只是一个 `relativePath` 和它的单测。

**删除时把引用它的 `<img>` / `<a>` 整段移除。** 看起来更「干净」，实际是替用户改正文 DOM：
一个 `<figure>` 里删掉 `<img>` 会留下空 `<figcaption>`，段落里删 `<a>` 会吞掉链接文字。
删除动作只负责删文件，正文怎么修由人决定。

**文件树拖拽重排 spine。** 体验更好，但要重做一套无障碍键盘路径，且在 28 项单列窄栏里收益
有限。上移/下移是文件树右键菜单的自然延伸，拖拽以后可以作为它之上的一层加，不会白做。

## Consequences

**交付实测（2026-11-19）**

- core：`opfEdit` 12 例、`references` 17 例单测通过。
- 真实书：604 处引用 / 33 个文本文件，重命名 `EPUB/text/cover.xhtml` 只改写 2 处（OPF + nav），断链 0，`../cover.jpg` 未被误伤。
- 浏览器实测：重命名含图章节后预览图 236×338 不变；文件树顺序调整、删除引用清单由 5 条 e2e 覆盖。
- 撤销栈：切 tab 后 ⌘Z 仍能撤销切走前的输入（2 条 e2e）。
- EPUB 2 路径仍只有构造样本单测，没有真实样本。

**已接受的代价**

- 目录同步是脆弱点：pandoc 生成的 177 项嵌套 + 标题内联 `<markup>`，任何序列化差异都会被放大。
  nav/NCX 的改写沿用现有 `writeNavToc` / `writeNcxToc`（它们已通过往返断言），重命名只改 `entry.href`。
- 只有 EPUB 3 真实样本。EPUB 2 的 `toc.ncx` 路径改动只有构造样本单测覆盖。
- `rewriteReferences` 改的是整段文本文件，会与用户手上的未保存编辑叠加：操作顺序是先改引用再改
  自己的文本，两者都在 `texts` 里，不额外保存。
