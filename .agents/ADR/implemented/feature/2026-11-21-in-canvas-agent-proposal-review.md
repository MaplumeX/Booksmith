# ADR: In-canvas EPUB Agent proposal review with book-page revisions & per-hunk approval

Status: implemented

## Problem

在 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 与 [the dedicated Agent sidebar chat UI](../design/2026-11-20-agent-sidebar-chat-ui.md) 落地后，`review`（审阅）模式下所有写操作汇总为 `AgentProposal`，并仅在右侧 `400–560px` 对话侧栏内的 `AgentProposalCard` 中紧邻工具步骤展示：

1. **窄栏源码片段与书籍内容割裂**：提案 Diff 挤在 ~360px 宽的卡片内，仅保留 2 行上下文且无行号、最多展示 80 行。编辑者既看不清改动位于章节的哪一段上下文，也无法看到排版渲染后的真实书页效果（文字润色、段落结构、CSS 样式或公式渲染变化）。
2. **单章多处校对缺少逐处取舍能力**：一章 EPUB 动辄数万字，Agent 单轮校对常在同一章修改多处段落；既有实现仅支持纯文本提案「按文件勾选」，只要同一章有一处改歪，用户就只能整章拒绝重来或全盘接受后手工返工。
3. **样式与结构变动难以直观审阅**：修改 `.css` 样式表、目录或拆分/新建章节时，仅看折叠源码难以直接确认对成书视觉与结构的影响。

## Decision

部分替代 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md)（提案审阅界面与纯文本审批粒度条款）与 [the dedicated Agent sidebar chat UI](../design/2026-11-20-agent-sidebar-chat-ui.md)（侧栏提案卡内嵌源码 Diff 条款），严格保留两份既有记录中的核心工具层、服务端沙盒 overlay、密钥加密、工作区单一保存路径、结构变更原子应用及右侧栏 IM 气泡对话流，并遵循 [the Soft Craft Studio UI](../design/2026-11-20-soft-craft-studio-ui.md) 语义 Token 体系：

### In-canvas takeover & slimmed sidebar card

- **中央主画布原位审阅**：在 `review` 模式下新提案落定（或 `auto` 模式触发安全降级转人工审阅）时，`apps/web/src/routes/Editor.tsx` 自动切入只读审阅视图 `apps/web/src/ui/ProposalReviewPane.tsx` 并定位至首个改动文件的第一处变更；全局同时仅激活 1 条提案在主区审阅，左侧 `apps/web/src/ui/FileTree.tsx` 为涉及到的既有文件展示语义徽标（`改` / `增` / `移` / `删`）。
- **零污染隔离与暂存恢复**：审阅层不修改真实浏览器工作区、不触发脏状态与自动保存；原有 `CodePane` 与 `PreviewPane` 通过 `hidden` 保持挂载以保留各标签页 CodeMirror 撤销栈与预览 iframe 状态。点击左栏待审阅文件直接在审阅视图内切换；点击普通文件或「退出」回到正常编辑，未提交的逐处勾选状态暂存在当前会话内存中（`skippedHunksByMessage`），点侧栏卡片随时恢复。
- **侧栏 `AgentProposalCard` 瘦身为导航摘要卡**：`apps/web/src/ui/AgentProposalCard.tsx` 移除内嵌折叠源码 Diff，仅保留变更文件清单、`+N / -M` 统计、已选 Hunk 计数、当前审阅高亮态（「审阅中」）与「审阅变更 / 应用 / 放弃」操作；对已应用提案（含 `auto` 模式）提供「查看改动」主区只读回看入口。

### Three-mode book-centric review (`修订` / `终稿` / `源码`)

考虑到 `1440px` 视口同时展开左结构栏（`256px`）与右助手栏（`440px`）后中央主区约 `740px` 宽，采用单页仿真书页布局（书页 `max-width: 760px`，源码 `max-width: 900px`），顶部审阅栏提供 Radix `DropdownMenu` 文件切换、`[ 修订 | 终稿 | 源码 ]` 三态切换与 `↑ / N/M / ↓` 变更跳转：

- **修订（章节默认）**：`apps/web/src/preview/revisionView.ts` 的 `buildRevisionXhtml` 基于源码 `ProposalHunk` 行号锚点标注章节 XHTML 并交给 `buildPreviewDocument` 渲染真实书稿 CSS、字体、图片与暗色适配。正文纯文字改动原位呈现红底删除线（`.bs-rev-del`）与绿底下划线（`.bs-rev-ins`）；整块增删与 `<math>`/`<svg>`/`<img>`/`<table>` 保护岛保持完整结构并以带图标徽标的上下对照区块呈现；纯标签/属性/`class`/`style` 改动标出虚线轮廓与「标签/样式变更」徽标（点击跳源码）；`<head>` 变动在顶部提示条引导切源码；每处内容块以 `data-bs-hunk` 定位焦点，块内「跳过 / 恢复保留 / 看源码」按钮使用独立 `data-bs-target-hunk` 属性并通过跨 iframe 安全点击委托响应，跳过后原位回退原文。
- **终稿**：去掉所有修订标记，基于 `apps/web/src/state/proposalReview.ts` 的 `buildVirtualReviewBook` 构造的只读虚拟叠加书稿实时渲染应用后的纯净书页效果。
- **源码（非章节默认）**：带 1-based 双行号与可展开折叠未变上下文的完整源码 Diff，与「修订」视图共享同一套 `ProposalHunk` 勾选状态与 `↑ / ↓` 焦点索引。

### Per-hunk approval, XML validation & CSS/structural helpers

- **逐处变更块（Hunk）审批**：`apps/web/src/state/proposalReview.ts` 将纯文本提案按连续变更行切分为 `ProposalHunk[]`（保留原始 CRLF/LF 行尾），默认全部预选保留、按需跳过；前端 `composeFileFromHunks` 重组最终文本并通过 `applyProposalToBook` 的可选 `composedTexts` 落入浏览器工作区（后端 API 与数据库零改动）。应用前由 `validateComposedProposal` 运行 `checkXmlWellFormed` / `browserXmlParser` 校验，跨行标签失配时阻断应用并提供一键恢复或切源码排查。
- **结构摘要与 CSS 联动预览**：结构变更提案维持整批原子应用，并在主审阅条下方展示 `summarizeStructuralProposal` 摘要与断链/预检诊断；选中 `.css` 文件时由 `findReferencingChaptersForCss` 扫描引用该样式表的 spine 章节，支持一键在章节终稿中切换对比「修改后样式 / 修改前样式」。
- **过时基准提醒**：点击应用历史待审阅提案时，由 `detectProposalStaleness` 比对 `beforeText` 与当前工作区，若发生漂移则弹出 Radix `Dialog` 确认后再覆盖应用。

## Alternatives considered

**大尺寸居中模态弹窗审阅（类似 `VersionHistory`）**。对现有 `Editor.tsx` 主画布零侵入，但弹窗会遮挡右侧 AI 对话栏，审阅期间无法边看书籍变化边与 Agent 追问调整。放弃。

**直接把修订层叠加进可编辑的 `CodePane` / `WysiwygPane`**。支持边审阅边手动编辑，但极易与内存工作区、IndexedDB 草稿、自动保存和结构变更原子性产生状态冲突，边界复杂度过高。放弃。

**强制左右双页并排对照（左改前书页 | 右改后书页）**。同时打开左右侧栏时主区仅约 `740px` 宽，双页每侧不足 `360px` 导致正文折行破碎，强行自动收起左栏又会破坏用户工作台布局。采用单页 `760px` 仿真书页 + `[ 修订 | 终稿 | 源码 ]` 三态切换。

**仅提供书页修订视图、去掉源码 Diff 或去掉「终稿」视图**。纯书页修订会丢失 `class`、属性、链接与 OPF 元数据可见性（见 [source-level snapshot diff](2026-11-19-document-diff.md)）；缺少「终稿」则无法在去除红绿标记后验收真实排版与 CSS 样式效果。放弃。

**保持纯文本仅文件级审批，或要求每个 Hunk 默认未决逐条点击接受**。仅文件级在单章多处校对时无法精准挑拣；默认未决则令 15–20 处错别字校对操作成本过高。采用 Hunk 默认全选、按需跳过。

**手动点击侧栏卡片才进入主区审阅，或在侧栏保留旧折叠 Diff 开关**。审阅模式下等待 Agent 改完后的第一动作即是核查变化，手动进入多一步冗余点击；侧栏保留折叠 Diff 会导致双套展示冗余并继续挤压对话流。采用自动进入 + 彻底瘦身侧栏卡片。

## Consequences

**验收结果（2026-11-21）**

- 全仓类型检查、构建与自动化单测/集成测试全部通过：`pnpm -r typecheck` 与 `pnpm -r build`（`core` / `server` / `web` 2333 modules）均 0 错；`pnpm test` 39 个文件、325 条单测通过（含新增 `proposalReview.test.ts` 4 条、`revisionView.test.ts` 6 条及扩展后的 `agentProposal.test.ts`）；`pnpm --filter @booksmith/server test` 7 个文件、72 条集成测试通过。
- 视觉对比度与巡检通过：`check_contrast.py` 实测浅/暗全部 8 组修订与徽标语义配对均在 `5.29:1–8.16:1`；`node e2e/audit-shots.mjs` 输出 `audit: clean`（`1440px` / `400px` 浅暗双主题零横向溢出、零断图、零报错）。
- 端到端测试通过：`pnpm exec playwright test e2e/agent.spec.ts` 通过（覆盖审阅模式自动切入主画布书页修订视图、iframe 内逐处跳过第 2 处 Hunk、「终稿 / 源码」三态同步、退出/恢复暂存草稿、左栏文件树待审阅徽标、部分应用精确落盘、CSS 联动引用章节终稿改前/改后对比、结构变更摘要与原子应用、已应用提案只读回看与 `1440px`/`400px` 零横向溢出）。
- 待 PR Review 人工目视确认项：在真实复杂书稿（如含内联 `<math>` 章节的样本书）浅/暗双主题下确认书页「修订」高亮、保护岛对照与「终稿 / 源码」三态观感。

**代价与已知限制**

- **复杂嵌套 XHTML 的修订映射边界**：遇到跨多段落的标签重组或深度嵌套内联元素时，字符级内联修订自动回退为同构前后对照区块（`bs-rev-compare-before` / `bs-rev-compare-after`）或跨行标签跳转徽标，保证不破坏渲染与保护岛，细节需切「源码」视图精查。
- **部分 Hunk 跳过可能拆断跨行标签**：单元素跨多行且首尾标签落入不同 Hunk 时，仅跳过其一会被前端 XML 校验阻断应用，用户需点击「恢复该文件全部改动」或切源码调整关联 Hunk。
- **未提交 Hunk 草稿仅限当前会话内存**：刷新页面或重新加载书籍后未应用的跳过选择不跨刷新保留，有意避免引入额外的本地存储同步状态。
- **审批闭环与累计草稿协同（2026-11-21）**：[continuous multi-turn Agent sessions](2026-11-21-agent-session-continuity.md) 在完整保留本记录主画布三态审阅与逐 Hunk 审批的基础上，补齐了部分跳过 Hunk 摘要与 `reverted` 撤销状态回流、以及未过时待审阅提案自动承接与 `superseded` 卡片态。
- **实时流式审阅与三态逐处审批演进（2026-11-22）**：本文档中「回合落定后才进入主画布审阅」「二态跳过开关」与「顶栏应用/放弃操作位」条款已由 [real-time streaming Agent review with Cursor-style 3-state hunk approval](2026-11-22-live-streaming-agent-review.md) 部分替代，升级为写工具成功即实时增量流式切入、内容指纹防漂移、智能自动跟随、三态 `保留 / 拒绝`（接受即视觉收起）与底部紧凑审阅推进条；仿真书页三态视角、保护岛对照、CSS 对比、XML 校验、过时提醒与零污染隔离约束均保持有效。
- **章节跨行 Hunk 归并与分层结构修订演进（2026-11-22）**：本文档中「复杂嵌套/跨行标签回退为通用对照块或跳转徽标」条款已由 [contiguous blockquote rendering and structure-aware book-page revision preview](2026-11-22-contiguous-quote-and-structural-revision-preview.md) 局部演进，新增 40 行跨度护栏内的章节结构感知 Hunk 归并、容器递归原位修订、行内格式原位高亮、语义化结构对照与块内就地展开微型源码 Diff；超跨度跨行标签仍保留拆分并继续受本文档 XML 良构校验保护。
