# ADR: Flat editorial Agent messages with unified collapsible process drawer & per-step reasoning state

Status: implemented

## Problem

在 [the dedicated Agent sidebar chat UI](2026-11-20-agent-sidebar-chat-ui.md)、[Agent approval modes, multi-model providers, preferences, reasoning & retry](../feature/2026-11-20-agent-modes-and-multimodel.md) 与 [continuous multi-turn Agent sessions](../feature/2026-11-21-agent-session-continuity.md) 落地后，实际在 `400–560px` 窄侧栏中运行多步推理与工具校对时，消息流呈现暴露出三类体验缺陷：

1. **过程噪声淹没最终回复**：多步执行（`思考 → 工具 → 过渡语 → 思考 → 工具 → 最终回复`）将每个思考框、工具框和过渡文本作为独立块平铺在消息流中，一轮校对动辄撑出 5–8 个零碎卡片，用户很难一眼扫到最终结论。
2. **多思考块共享「正在思考」状态**：流式渲染仅根据其后是否已出现 `text` 片段（`hasTextAfter`）判断某个思考块是否结束。在最终回复尚未输出前，多步工具调用之间的**所有**历史思考块均同时显示转圈与「正在深度思考…」并全部自动展开，底部还会叠加一个独立的 `showThinkingTail` 气泡，状态严重失真。
3. **窄栏内盒中套盒、有效阅读宽度偏窄**：助手回复被包裹在带 `24px` 左侧头像列、灰底与描边的 `.agent-bubble.is-assistant` 内，与上方的多张边框思考/工具卡片叠在一起，在 `400–560px` 侧栏内造成明显视觉拥挤，并白白挤压掉约 `50px` 的 Markdown 列表、代码块与 GFM 表格宽度。

## Decision

部分替代 [the dedicated Agent sidebar chat UI](2026-11-20-agent-sidebar-chat-ui.md)（助手左对齐头像气泡与独立工具框条款）、[Agent approval modes, multi-model providers, preferences, reasoning & retry](../feature/2026-11-20-agent-modes-and-multimodel.md)（独立 `ReasoningBlock` 自动展开条款）与 [continuous multi-turn Agent sessions](../feature/2026-11-21-agent-session-continuity.md)（§4 平铺交错时间线渲染条款）；保持服务端完整轨迹落库与回放、80% 自动压缩、主画布审阅、侧栏 `38px` 顶栏、底部输入卡及 [the Soft Craft Studio UI](2026-11-20-soft-craft-studio-ui.md) 语义 Token 体系不变（零新增 Token）：

### Design Thesis

- **Visual**：保留用户消息右对齐实心 `--accent` / `--accent-fg` 胶囊作为对话锚点；助手回复去气泡化并移除 `24px` 头像占位列，Markdown 直接通栏排布在 `--surface` 纸面上；过程区收拢为无厚重边框的轻量内联披露行，展开后通过左侧 `1px solid var(--border)` 细时间轴竖线串联步骤，消除盒中套盒。
- **Content**：在 `400–560px` 侧栏内为助手正文释放约 `50px` 横向排版空间；每轮主视图仅突出展示「可选单行过程折叠条 → 最终 Markdown 回复 → 紧凑操作行 → 提案导航卡」，使长校对回复、代码块与表格自然舒展。
- **Interaction**：过程抽屉在流式期与完成后均默认折叠（流式期展示单行实时动态播报，完成后定格为汇总计数），用户随时可点开查看完整顺序轨迹；动效仅用 `opacity` / `transform` / 颜色过渡（`120–160ms`，遵循 `prefers-reduced-motion`），完整支持 `aria-expanded` 与 `:focus-visible`。

### Pure Timeline Projection & Per-Step State Isolation

`apps/web/src/state/agentTimeline.ts` 将原始 `AgentTimelineItem[]` 与并发 `runningTools[]` 归约为 `AgentTurnView`：

- **统一过程收纳**：将除最终回复外的全部 `reasoning`、`tool` 与工具前过渡文本 `note` 按真实执行顺序放入 `processSteps`；流式期间若尾部为 `text` 则实时外显在 `finalText`，一旦后续触发新工具或思考步骤则平滑归入 `processSteps`；回合结束时若末尾无独立总结正文但存在前序文本，自动将最后一段非空文本提升为 `finalText`（避免空白回复）；纯工具回合（零文本）则仅展示过程条与提案卡/错误条。
- **严格逐块隔离思考状态**：每个 `reasoning` 步骤携带独立 `status: 'active' | 'done'`，仅当 `isStreaming && isLastEntry`（且无挂起于尾部的 `runningTools`）时为 `'active'`；一旦工具开始执行、工具结束或新步骤紧随其后，所有前序思考块立即转为 `'done'`。
- **并发工具跟踪**：`StreamingState` 使用 `runningTools: RunningToolCall[]` 替代单一可空 `runningTool`，通过 `applyToolEndToRunning()` 按 `id` 精确匹配结束项，避免同一步并发调用多个工具时互相覆盖 `argsSummary`。

### Component Contracts & State Matrix

| 组件 | default | empty | loading | error | edge |
|---|---|---|---|---|---|
| `AgentProcessDrawer` | 折叠单行汇总（如 `思考 2 次 · 调用 1 个工具`、`已思考 · N 字`），点击展开左侧 `1px` 时间轴（思考块各自默认折叠、可独立展开；工具行含图标+动作+路径+结果摘要；过渡语弱化呈现） | 无思考/工具/过渡语且非流式时不渲染 | 单行实时动态播报（`正在思考…` / `正在深度思考… · 已完成 N 步` / `正在<动作>（<参数>）…`），移除底部冗余 `showThinkingTail` 气泡；点开后仅尾部活动思考块转圈并展开预览 | 任一工具失败时，折叠汇总行即展示错误图标与失败计数（`N 项失败`） | 连续多思考块绝不共享思考态；长思考限高 `200px` 独立滚动；长路径单行省略带 `title`；旧版无 `timeline` 历史消息平滑回退 |
| `AgentPanel` 助手回复区 | 通栏无框 `.agent-reply`（`AgentMarkdown`）最终正文 + 悬停/聚焦可见 `复制 / 重试` 与时间戳 + `AgentProposalCard` | 沿用未配置 `EmptyState` 与无消息欢迎卡 | 尾部正文实时流式渲染；助手骨架屏去框轻量化 | 回合错误以通栏 `role="alert"` 横幅呈现（无正文亦不现空壳） | 纯工具回合零空白正文；宽表格/长代码独立横滚；`400px` 移动抽屉零横向溢出 |

## Alternatives considered

**只将思考和工具收进折叠条，中间过渡文字仍作为独立气泡留在外面**。中间过渡语无需点击即可看到，但在模型边调工具边说明步骤的场景下，对话流仍会被 3–4 个折叠条与零碎短气泡切碎，无法达到「只显示最后的消息」的整洁度。放弃。

**流式生成期间默认自动展开过程抽屉（并在最终回复出现后自动收起）**。过程在生成期更透明，但长思维链在 `400–560px` 窄侧栏内会频繁撑满并剧烈滚动，干扰用户审阅主画布或在底栏提前起草下一条指令。放弃，改为流式期单行实时播报 + 随时手动展开。

**保留现有 IM 左右气泡与 `24px` 助手头像列，仅合并过程折叠条**。改动最小且沿用既有 DOM 结构，但窄栏内仍残留约 `50px` 头像/内边距浪费与多层边框嵌套感，视觉精炼度受限。放弃。

**在设置页额外新增「流式期默认展开思考」偏好开关**。会增加不必要的配置项与云端字段负担；默认紧凑单行 + 一键展开已兼顾清晰与透明。暂不引入。

## Consequences

**验收结果（2026-11-22）**

- 纯函数时间线单测与全量单测通过：`pnpm exec vitest run apps/web/src/state/agentTimeline.test.ts` 8/8 通过；`pnpm test` **40 个文件、334 条单测全部通过**。
- 全仓类型检查与构建通过：`pnpm -r typecheck && pnpm -r build`（`core` / `server` / `web` 2334 modules 均 0 错）。
- 浅/暗对比度与渲染巡检通过：`check_contrast.py` 实测浅/暗 8 组语义配色对比度在 `5.92:1–16.17:1`（全部 `>= 4.5:1`）；`node e2e/audit-shots.mjs` 输出 `audit: clean`（`1440px` / `400px` 浅暗双主题零横向溢出、零断图、零报错）。
- 端到端回归测试通过：`pnpm exec playwright test e2e/agent.spec.ts` **3/3 通过**（含新增的双阶段推理流式状态隔离测试：在第二阶段思考流式期间展开抽屉断言仅第二思考块处于 `active`、第一思考块已定格为 `done`，结束后折叠为单行汇总并仅外显最终回复，刷新后完整持久化）。
- 待 PR Review 人工确认项：接入真实推理模型运行包含多次思考与工具调用的校对任务，确认流式单行播报稳定、展开后仅当前思考块处于思考态、完成后仅显示最终回复且浅/暗阅读体验自然。

**代价与已知限制**

- **中间过渡语折叠**：若少数弱模型仅在工具调用前写出关键结论而结尾简略回复「已完成」，需点开过程抽屉查看过渡语（当回合末尾无独立文本时已自动将最后一段非空文本提升为外显回复以兜底）。
- **既有文档关系**：[the dedicated Agent sidebar chat UI](2026-11-20-agent-sidebar-chat-ui.md)、[Agent approval modes, multi-model providers, preferences, reasoning & retry](../feature/2026-11-20-agent-modes-and-multimodel.md) 与 [continuous multi-turn Agent sessions](../feature/2026-11-21-agent-session-continuity.md) 仍承载侧栏壳层、Token、审批模式、多模型、后端轨迹回放与 80% 压缩等核心活跃约束，故保留在 `implemented/` 并完成双向交叉链接。
