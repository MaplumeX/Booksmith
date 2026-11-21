# ADR: Contiguous blockquote rendering and structure-aware book-page revision preview

Status: implemented

## Problem

在 [reader baseline typography and dark adaptation](../design/2026-11-21-reader-typography-and-dark-adaptation.md) 与 [in-canvas Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md)（及其 [real-time streaming review evolution](2026-11-22-live-streaming-agent-review.md)）落地后，实际编校 EPUB 尤其是处理多段引文与块级重构时暴露出两类明显体验断层：

1. **相邻引用块视觉割裂**：`buildReaderBaseCss` 为每个 `<blockquote>` 单独施加 `margin: 1.1em 0`、四边内边距、灰底衬块与右侧圆角。许多经转换或逐段标引生成的 EPUB 会把一段多自然段引文写成多个相邻 `<blockquote>`，导致阅读预览、可视化校对与审阅书页中出现多张彼此断开的独立灰卡，而非连贯的整块引用。
2. **书页「修订」视图在结构/跨行标签编辑下看不出前后差异**：
   - 按行切分的 `buildFileHunks` 会把包裹/取消跨行容器（如在已有 `<p>` 外加减 `<blockquote>...</blockquote>`）拆成两个不闭合 Hunk；`revisionView.ts` 因片段不闭合落入 `跨行标签变更` 回退分支，只输出 `afterFrag` 挂一枚抽象胶囊（删除标签时甚至完全空白），且用户单独拒绝其中一侧还会触发 XML 闭合报错；同时 `rejected` 态遗漏了恢复控制条。
   - 嵌套块内纯文字修改（如 `<blockquote><p>错字</p></blockquote>`，因 `<p>` 不在 `INLINE_SAFE_TAGS`）、行内格式增删（如加 `<strong>`/`<em>`）或容器变更（`<p>` ↔ `<blockquote>`）全部退化为泛化的 `段落结构变更` 上下两坨无字级高亮的 `原 / 新` 全文块，既不说明结构如何变化，也难以辨认文字本身是否改动；当改前改后渲染外观相近（如 `<p class="quote">` → `<blockquote>` 或纯属性变更）时，必须切离书页去整页源码中核对。

## Decision

在不修改用户 EPUB 源码、不新增设计系统 Color Token、不改动后端协议与数据库的前提下，对阅读基线与主画布书页修订管线实施三层协同增强，局部演进 [reader baseline typography and dark adaptation](../design/2026-11-21-reader-typography-and-dark-adaptation.md)（相邻引用块接缝样式）与 [in-canvas Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md)（章节跨行 Hunk 归并与书页修订渲染），并受 [Soft Craft Studio UI](../design/2026-11-20-soft-craft-studio-ui.md) 语义色阶与零污染审阅隔离边界约束：

### 1. 零权重相邻 `<blockquote>` 无缝拼接

- [render.ts](../../../../apps/web/src/preview/render.ts) 的 `buildReaderBaseCss` 在 `:where(blockquote)` 后补充零特异性规则 `:where(blockquote:has(+ blockquote))` 与 `:where(blockquote + blockquote)`：清零接缝处 `margin-bottom` / `margin-top`、移除接缝侧圆角（`border-bottom-right-radius: 0` / `border-top-right-radius: 0`），两侧各保留 `0.375em` 内边距（合计 `0.75em`，与单 `<blockquote>` 内相邻 `<p>` 间距严格一致）。
- [revisionView.ts](../../../../apps/web/src/preview/revisionView.ts) 将 `[data-bs-rev="accepted"]:not(blockquote)` 排除在强制圆角覆写之外，避免已保留的引用块破坏相邻拼接；所有原书自定义 CSS 仍按更高特异性自然覆盖。

### 2. XHTML 章节结构感知 Hunk 归并

- [proposalReview.ts](../../../../apps/web/src/state/proposalReview.ts) 在 `buildFileHunks` 尾部仅对 XHTML 章节路径（`isChapterPath`）运行 `coalesceStructuralChapterHunks`：
  - `analyzeFragmentTagBalance` 跳过注释、处理指令、CDATA、DOCTYPE 与 void/自闭合标签后计算每个 Hunk 的未闭合开/闭标签栈；
  - 对存在未闭合开标签且无前置未匹配闭标签的 Hunk，在不跨 `<body>`/`</body>` 边界且累计间隔未改行数不超过 `40` 行（`MAX_STRUCTURAL_COALESCE_GAP`）的护栏内向前扫描，一旦与后续 Hunk 共同达到 `before` 与 `after` 双侧闭合即归并为单个原子 `ProposalHunk`；
  - 归并后顺序重编 `hunk-0..N`、同步更新 `allLines[].hunkId` 与内容指纹 `fingerprint`，`addedCount` / `removedCount` 仅统计真实变更行，不把中间未改行计入增删数；
  - 超过 `40` 行跨度的整章级包裹保持拆分粒度，仍由 `validateComposedProposal` 守护 XML 良构性；接缝型单 Hunk（如 `</blockquote>\n<blockquote>`）本身已自洽，不误并。

### 3. 分层智能书页修订与就地折叠微型源码对比

- [revisionView.ts](../../../../apps/web/src/preview/revisionView.ts) 与 [ProposalReviewPane.tsx](../../../../apps/web/src/ui/ProposalReviewPane.tsx) 按五级优雅降级渲染章节修订并支持就地展开微型源码 Diff：
  1. **容器递归原位修订**：`renderContainerElementPair` 对同标签容器（`blockquote`、`div`、`section`、`article`、`aside`、`ul`、`ol`、`li`、`dl`、`figure`）通过子块 LCS 对齐递归调用单块原位修订，嵌套段落内改字直接呈红绿字符差异，未改子块保持安静。
  2. **行内格式变更原位标示**：`tryInlineFormatOnlyDiff` 在纯文本未变且仅涉及安全行内标签（`strong`/`em`/`a` 等）增删或属性变化时，原位渲染目标内容并以 `.bs-rev-fmt-changed` 柔和标出变动片段，附具体徽标（如 `行内格式变更 (+strong)`）及「标签对比」入口。
  3. **语义化 `原 / 新` 对照与框内字级高亮**：`describeStructuralChange` 生成明确中文动作标签（如 `包裹为引用 (p×2 → blockquote)`、`取消引用 (blockquote → p)`、`合并相邻引用块`、`拆分段落 (1 → 2)`、`标题层级变更 (h3 → h2)`）替代泛化 `段落结构变更`；`highlightCompareFragments` 在纯文本一致时标注「文字未变 · 仅结构/标签调整」，纯文本亦有改动时跳过保护岛（`math`/`svg`/`img`/`video`/`audio`/`table`）在 `原` / `新` 文本节点内注入 `<del>` / `<ins>` 高亮（保持 `&entity;` 实体完整）。
  4. **接缝、多行开标签属性与超跨度不闭合标签**：`detectSeamHunk` 为相邻容器合并/拆分（`</blockquote>\n<blockquote>`）渲染 `.bs-rev-seam` 语义横条；`detectOpeningTagAttrChange` 为多行开标签属性变更（`<blockquote class="a">` → `<blockquote class="b">`）直接注入 `data-bs-rev="attr"` 并列出变动属性名；`describeUnbalancedTagHunk` 为超 40 行归并上限的孤立标签输出方向性提示（`+ 跨行开始 <section>` / `- 移除结束 </blockquote>`）；同步补齐所有不闭合 Hunk 在 `rejected` 态的恢复控制条。
  5. **就地展开微型源码 Diff**：通过 `data-bs-action="toggle-diff"` 复用 `ReviewBookIframe` 既有点击委托与 `ProposalReviewPane` 的 `expandedDiffHunksByPath` React 状态（零 iframe 脚本，跨 `patchDocument` 与流式更新保态、切换提案自动清空），在结构/属性/行内格式/跨行标签块内按需展开 `.bs-rev-minidiff` 紧凑等宽源码对比（上限 24 行，超出可滚动或一键「看源码」；对 `<p>`/`<h1>`–`<h6>` 等不可嵌套 `<div>` 的元素将微型对比面板渲染于闭合标签之后以符合 HTML5 解析模型）。

## Alternatives considered

**去掉引用块默认灰底圆角卡片，改为左侧细线 + 缩进的纸书轻样式**。虽能减轻相邻 `<blockquote>` 断裂感，但会改变 [reader baseline typography](../design/2026-11-21-reader-typography-and-dark-adaptation.md) 已锁定的视觉风格并弱化单段引用的区块区分度。采用零权重相邻拼接规则。

**保持相邻 `<blockquote>` 分段渲染，仅在检查/编辑侧提示用户手工合并源码**。虽如实暴露源码拆分，但无法改善大量既有 EPUB 在阅读与预览中的直接观感。放弃。

**保持 `proposalReview.ts` 按行切分不变，仅在 `revisionView.ts` 做跨行标签配对标注**。虽不触碰底层 Hunk 模型，但用户仍需对首尾两处 Hunk 分别审批，且单独拒绝一侧仍触发 XML 闭合报错。采用带 40 行跨度护栏的结构感知归并。

**不做容器递归原位修订，或去掉块内就地展开微型源码对比**。不做递归会让 `<blockquote><p>改一字</p></blockquote>` 仍占双倍高度；缺少就地微型源码对比则在 `<p class="quote">` → `<blockquote>` 或纯 `class` 变更等视觉相近场景下仍需切离书页。采用分层智能修订 + 就地折叠微型对比。

## Consequences

**验收结果（2026-11-22）**

- `pnpm -r typecheck && pnpm -r build`：全部 3 个包（`core` / `server` / `web` 2334 modules）类型检查与生产构建通过，0 错。
- `pnpm test`：40 个测试文件、342 条单元测试全部通过（含 `render.test.ts` 9 条、`proposalReview.test.ts` 7 条、`revisionView.test.ts` 10 条）。
- 视觉对比度与巡检：`check_contrast.py` 实测浅/暗全部 14 组审阅与微型源码 Diff 配色配对均在 `5.29:1–14.72:1`（全部 `>= 4.5:1`）；`node e2e/audit-shots.mjs` 输出 `audit: clean`。
- 端到端测试：`pnpm exec playwright test` 下 `e2e/preview.spec.ts`（6/6，含连续 `<blockquote>` 接缝 `margin`/`border-radius` 均为 `0px` 断言）、`e2e/wysiwyg.spec.ts`（8/8）与 `e2e/agent.spec.ts`（5/5，含跨行引用包裹归并、语义标题与「文字未变」提示、块内「标签对比」展开/收起、引用内错字原位红绿修订、以及单独拒绝包裹 Hunk 后 XML 有效且其余改动正常落盘）共 19/19 全部通过。
- 待 PR Review 人工目视确认项：在真实含连续 `<blockquote>` 的 EPUB 章节浅/暗双主题下确认连续引用观感，并在书页「修订」视图中目视确认包裹/取消/合并引用、引用内改字与「标签对比」展开节奏。

**代价与已知限制**

- **相邻独立引用视觉合并**：若某书稿刻意将两段不同出处的 `<blockquote>` 紧挨排列且中间无正文/分隔，零权重拼接规则会令两者共享连续左侧竖线与底色；原书自身 CSS 显式指定 `margin` 即可覆盖。
- **40 行以内包裹的审批粒度**：若 40 行以内的容器包裹同时夹杂内部一处局部文字修改，两者归入同一原子 Hunk 共同保留或拒绝；超过 40 行则不强并，避免整章级包裹吞没独立校对点。
- **既有文档关系**：[reader baseline typography and dark adaptation](../design/2026-11-21-reader-typography-and-dark-adaptation.md) 与 [in-canvas Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md) 仍承载暗色色彩自适应、基础色阶、三态画布、虚拟书稿、CSS 联动预览与 XML 校验等活跃约束，均保留在 `implemented/` 并完成双向交叉链接。
