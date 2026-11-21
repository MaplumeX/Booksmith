# ADR: Real-time streaming Agent review with Cursor-style 3-state hunk approval & soft-stop preservation

Status: implemented

## Problem

在 [in-canvas EPUB Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md) 与 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 落地后，`review`（审阅）模式仍采用「整轮结束一次性出结果」的批处理流程：

1. **漫长黑盒等待**：Agent 连续执行多步 `edit_file` / `write_file` / 目录与结构工具期间，主画布停留在原编辑页，用户看不到任何实时修改进展，只能盯着右侧栏工具步骤条干等整轮结束。
2. **无法边看边审、及时止损**：若前两章改得很好但第三章开始跑偏，点击「停止」会直接将整轮沙盒改动丢弃（`proposal: null`），前功尽弃；也无法在 Agent 修改后续章节时提前对已完成章节做逐处审批决定。
3. **缺少 Cursor 式「点选即收起」的逐处审批手感**：既有二态开关（默认保留 + `跳过此处 / 恢复保留`）无法把已过目的改动单独标记为「已保留」并视觉收起红绿差异，且操作按钮集中在顶栏，三栏同时展开时较拥挤。

## Decision

部分替代 [in-canvas EPUB Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md)（回合落定后才进入审阅、二态 Hunk 开关与顶栏应用/放弃操作位条款）与 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md)（仅回合末推送 `proposal` 及中止丢弃沙盒变更条款），完整保留零污染隔离审阅画布、仿真书页「修订 / 终稿 / 源码」三态、保护岛对照、CSS 引用章节对比、XML 校验、结构变更原子应用与 [the Soft Craft Studio UI](../design/2026-11-20-soft-craft-studio-ui.md) 语义 Token 体系（零新增 Token、零数据库迁移）：

### 1. Non-blocking incremental SSE proposal streaming (`review` mode only)

- `packages/core/src/agentTools.ts` 为 `AgentWorkspace.buildProposal(id, options?: { validate?: boolean })` 提供轻量模式（`validate: false` 跳过全书 `validateStructure`，单步写工具仍保留即时 XML 良构校验），并导出 `AgentProposalDelta` 与纯函数 `diffProposalSnapshots(prev, next, options?)` 计算单步增量变更（`changedFiles`、`removedPaths`、`isStructural`、`focusPath`），避免大章节在每步重复全量传输。
- `apps/server/src/agent/runner.ts` 在 `approvalMode === 'review'` 下，每次写工具执行成功后立即通过 SSE 推送 `{ type: 'proposal_update', delta }`；`auto` 与 `ask` 模式维持原有行为，不发送中间 `proposal_update`。
- 回合自然结束时运行完整 `validateStructure` 预检，发送最终权威 `{ type: 'proposal', proposal }` 并持久化后发出带真实 `messageId` 的 `done`。

### 2. Soft-stop preservation of completed edits

- `apps/web/src/ui/AgentPanel.tsx` 在用户显式点击「停止」或底栏「停止并保留已改」时采用软中止策略：先调用 `POST /api/books/:id/agent/threads/:threadId/abort` 而保持 SSE 连接开启（附 3s 兜底硬中止），等待服务端安全收尾；组件卸载或切书维持立即硬断开。
- `apps/server/src/agent/runner.ts` 与 `apps/server/src/routes/agent.ts` 在 `abortSignal` 触发后，若处于 `review` 模式且沙盒存在已完成的新写操作，仍运行 `buildProposal(proposalId, { validate: true })`，发送最终 `proposal` 并持久化为 `pending` 提案（同步处理 `supersededMessageId`），随后发送 `done` 收尾，支持「见好就收」直接应用中止前改好的部分。

### 3. Fingerprint-anchored live decisions & smart auto-follow

- `apps/web/src/state/proposalReview.ts` 为每个 `ProposalHunk` 计算基于改前/改后内容与文件内出现序的稳定 `fingerprint`，并提供 `applyProposalDelta()`、`reconcileHunkDecisions()`、`reconcileProposalDecisions()` 与 `findNewestChangedHunkIndex()`，保证用户在流式期间提前做出的 `accepted / rejected` 决定在后续同文件追加修改与落定迁移 `messageId` 时不漂移。
- `apps/web/src/routes/Editor.tsx` 在首个写工具抵达即自动切入 `ProposalReviewPane`（`isLive: true, autoFollow: true`），后续写工具默认自动跟随最新修改文件与新增/变动 Hunk；用户手动切文件、切视角或主动导航即暂停自动跟随，仅静默刷新后台文件与计数，并在顶栏展示「正在编辑 `<文件名>` · 跟随」一键恢复胶囊；流式期主动点击「退出」后本轮不再强拉回画布，可随时从侧栏实时进度卡重入。

### 4. Cursor-style 3-state hunk approval & compact review footer bar

- 将纯文本逐处审批升级为三态 `HunkDecision = 'pending' | 'accepted' | 'rejected'`：
  - **`pending`（待审）**：展示红/绿差异与 `保留` / `拒绝` 双按钮。
  - **`accepted`（已保留）**：`apps/web/src/preview/revisionView.ts` 与 `apps/web/src/ui/ProposalReviewPane.tsx` 的源码视图均原位收起红绿差异呈纯净结果态，仅保留轻量绿色 `已保留` 徽标与 `撤销` 入口。
  - **`rejected`（已拒绝）**：原位回退原文（纯新增块折叠为轻量占位条），附 `已拒绝` 徽标与 `恢复` 入口。
  - 点击底部唯一主 CTA `应用变更` 时，`pending` 与 `accepted` 均计入保留，仅 `rejected` 回退原文，兼顾逐处细审与批量一键落盘。
- 顶栏补充单文件级 `保留本文件 / 拒绝本文件` 快捷操作；将 `放弃` 与主 CTA `应用变更` 下移至底部紧凑审阅推进条（`.review-footer-bar`），同步承载流式进度/软停止钮与落定态 `待审 / 已保留 / 已拒绝` 计数及跨文件 `下一处未审` 跳转；`apps/web/src/ui/AgentProposalCard.tsx` 新增 `isLive` 态，在侧栏流式气泡底部实时展示可点击跳转的文件清单。

## Alternatives considered

**逐步挂起拦截式审批（每步写工具暂停服务端等待前端放行）**。虽可在单步拒绝后让模型同轮重改，但连续校对 10+ 处时频繁暂停打断节奏，且需服务端维护跨请求挂起会话与超时回收（多进程部署复杂度高）。采用非阻塞流式实时审阅 + 软中止保留已改部分。

**直接将流式修改写入浏览器工作区并在 `CodePane` 内联叠层审阅（拒绝时回滚）**。虽更贴近代码编辑器原位编辑，但与既有书页三态审阅重造，且强耦合 `autosave`、IndexedDB 草稿、CodeMirror 撤销栈与结构变更原子性。沿用并实时驱动隔离层 `ProposalReviewPane`。

**同步将 `auto` 模式改为流式接管主画布**。`auto` 用户的诉求是后台无打扰执行并安全落盘，流式期强行接管主画布会打断当前阅读/编辑。收敛为仅改造 `review` 模式。

**流式期间主画布纯只读禁用逐处操作，或允许流式期间单文件直接落盘**。纯只读削弱「边生成边审批」的即时感；单文件提前落盘会破坏服务端运行中沙盒基线并绕过全书 `validateStructure` 预检。采用流式期可提前做三态决定（内容指纹保序）+ 落定/停止后解锁统一落盘。

**中止（停止）时保持丢弃沙盒变更**。实时审阅下看到跑偏及时喊停并保留前面改对的部分是高频刚需，丢弃会令前面步骤白费。改为软中止保留已完成变更并持久化为 `pending` 提案。

**沿用旧二态 `跳过此处` 单开关，或将 `pending` 默认视为拒绝**。旧二态无法把已过目改动视觉收起；`pending` 默认拒绝则会使多处校对操作负担倍增。采用三态显式 `保留 / 拒绝` + 应用时未表态默认保留。

## Consequences

**验收结果（2026-11-22）**

- 全仓类型检查与构建通过：`pnpm -r typecheck && pnpm -r build`（`core` / `server` / `web` 2334 modules 均 0 错）。
- 核心、前端与服务端自动化测试全部通过：`pnpm test` **40 个文件、337 条单测通过**（含 `packages/core/test/agentTools.test.ts` 13 条、`apps/web/src/state/proposalReview.test.ts` 6 条、`apps/web/src/preview/revisionView.test.ts` 6 条）；`pnpm --filter @booksmith/server test` **8 个文件、80 条集成测试通过**（含 `agentRunner.test.ts` 与 `agentRoutes.test.ts` 实时 `proposal_update` 与软中止保留提案测试）。
- 视觉对比度与巡检通过：`check_contrast.py` 实测浅/暗 10 组审阅语义色配对均在 `5.92:1–16.17:1`（全部 `>= 4.5:1`）；`node e2e/audit-shots.mjs` 输出 `audit: clean`。
- 端到端测试通过：`pnpm exec playwright test e2e/agent.spec.ts` **4/4 通过**（覆盖三态书页修订视觉收起与源码同步、受控多步流式实时切入与侧栏实时卡、流式期提前拒绝后同文件前插新 Hunk 的指纹保序、手动切换暂停跟随与一键恢复「跟随」、以及中途点「停止并保留已改」持久化并在刷新后成功应用）。
- 待 PR Review 人工目视确认项：在真实含多章与 MathML 的样本书上验证实时流式切入、手动接管/恢复跟随、点击「保留」原位收起与「拒绝」回退、中途点「停止」保留已改部分，以及浅/暗双主题下 `1440px` / `400px` 视口观感。

**代价与已知限制**

- **高频连续写工具的重绘密度**：单轮内模型若快速连续多次调用 `edit_file` 修改同一大章，每次 `proposal_update` 触发增量合并与 `patchDocument` 原位 DOM diff；当前通过增量传输与原位 DOM patch 保持流畅，后续如需极高频合批可在前端增加 rAF 节流。
- **软中止 3s 兜底边界**：显式停止时前端等待最多 3s 让服务端完成预检落库并关闭 SSE；若极端网络故障触发 3s 兜底硬断开，服务端仍会尽力落库部分提案，刷新页面即可恢复查看。
- **既有文档关系**：[in-canvas EPUB Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md) 与 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 仍承载书页三态渲染、保护岛、CSS 对比、XML 校验、核心工具层与密钥加密等活跃约束，均保留在 `implemented/` 并完成双向交叉链接。
