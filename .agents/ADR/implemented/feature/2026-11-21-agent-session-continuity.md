# ADR: Continuous multi-turn Agent sessions with full tool trace, proposal feedback loop & 80% auto-compaction

Status: implemented

## Problem

在 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md)、[Agent approval modes, multi-model providers, preferences, reasoning & retry](2026-11-20-agent-modes-and-multimodel.md) 与 [in-canvas EPUB Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md) 落地后，Booksmith 的内置 Agent 虽已具备多步工具调用与主画布书页审阅能力，但跨轮次的会话体验仍严重割裂，表现得像「每条消息各自为战」：

1. **工具调用与返回结果跨轮全丢**：服务端拼装历史时仅从 `agent_messages` 读取纯文本 `content` 与用户上下文 `context_json`，上一轮 `read_file` / `search_book` / `lint_book` / `edit_file` 的完整调用参数与返回原文回合结束即丢弃；空正文助手轮次还会被 `if (!trimmed) continue` 跳过，导致模型追问时失忆、被迫重读。
2. **提案审批与未应用草稿未接入会话闭环**：历史上下文完全不知晓上一轮提案已被应用、部分跳过 Hunk、放弃还是撤销；且每轮都按编辑器当前内容新建一次性沙盒，用户在审阅主画布修订时若不先点应用就直接追问微调，新旧提案会互相割裂或冲突。
3. **固定 24,000 字符硬截断**：`trimHistory` 写死 24K 字符上限，且不保证首条保留消息为 `user` 或消息角色合规；长会话既无法利用现代模型的大上下文窗口，也没有超过阈值时的自动压缩机制，同时缺乏按模型真实窗口大小（含本地 Ollama 与自定义中转）计算上下文预算的能力。
4. **前端会话状态易中断且执行过程失真**：关闭右侧助手栏直接卸载 `AgentPanel`（正在生成的流被中断，重开还会切回最新会话）；多步交错执行的思考、工具与正文在气泡中被强行拆分堆叠（所有工具折叠在顶部单一卡片），流式期间输入框锁定不可提前起草。

## Decision

部分替代 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md)（24,000 字符纯文本滑窗与每轮独立一次性沙盒条款）、[Agent approval modes, multi-model providers, preferences, reasoning & retry](2026-11-20-agent-modes-and-multimodel.md)（历史仅回放纯文本条款）与 [the dedicated Agent sidebar chat UI](../design/2026-11-20-agent-sidebar-chat-ui.md)（关闭侧栏卸载面板与工具统一置顶折叠条款）；完整保留既有 EPUB 工具原语、主画布仿真书页三态审阅（`修订 / 终稿 / 源码`）与逐处 Hunk 审批、AES-256-GCM 密钥加密及 [the Soft Craft Studio UI](../design/2026-11-20-soft-craft-studio-ui.md) 语义 Token 体系：

### 1. Canonical multi-step trace persistence & cross-provider replay

- 迁移 `apps/server/drizzle/0009_sharp_ravenous.sql` 为 `agent_messages` 增量新增 `steps_json`、`proposal_resolution_json` 与 `compaction_notice_json` 可空列，持久化每轮规范化、供应商无关的步骤轨迹（`reasoning` / `text` / `tool` 顺序记录，单条工具结果落库上限 32KB；回放时规范化 `toolCallId` 为 `[a-zA-Z0-9_-]{1,64}` 且不落库厂商私有思考签名），确保同一会话在 OpenAI 兼容接口、DeepSeek、Ollama 与 Anthropic 之间自由切换时消息链始终合法兼容。
- 面向前端的 `AgentMessageDto.timeline` 通过 `toTimelineItems()` 剥离原始工具返回体，仅下发展示所需的轻量时间线片段；历史旧消息（`steps_json` 为空）无缝回退为纯文本回放。

### 2. Cumulative pending proposal seeding & approval feedback loop

- `packages/core/src/agentTools.ts` 的 `AgentWorkspace` 新增 `detectPendingProposalDrift(proposal)` 与 `seedPendingProposal(proposal)`：在不修改真实基线 `initialTexts` / `initialPaths` 的前提下，将当前会话最新未过时的 `pending` 提案叠加入工作副本。
  - 若本轮仅问答、未产生新写工具成功调用，`buildProposal()` 返回 `null`，原 `pending` 提案保持不变；
  - 若本轮产生新写操作，则相对真实基线产出包含全部累计改动的最新提案，并将旧提案状态更新为 `superseded`（通过 `done` SSE 事件下发 `supersededMessageId`）；
  - 若用户期间手动编辑过相关文件造成基线漂移，则安全回退至当前编辑器工作区，并在历史上下文告知模型旧提案已过时。
- 提案状态扩展为 `pending | applied | dismissed | reverted | superseded`。前端在部分应用 Hunk 时通过 `PATCH /api/books/:id/agent/proposals/:messageId` 上报 `resolution` 摘要（保留/总 Hunk 计数与跳过文件），撤销应用时同步标记 `reverted`；服务端在历史回放中将这些真实审批结果以紧凑结构化标注注入对应助手轮次。

### 3. Dynamic 80% context window & two-tier auto-compaction

- **模型上下文窗口三级解析**：`apps/server/src/agent/contextWindow.ts` 实现三级窗口解析，`agent_profiles` 增量新增 `context_window`（用户可选覆写，2048–10,000,000，留空自动）与 `model_context_windows_json`（`fetchProviderModels` 解析 `/models` 时自动采集 `context_length` / `max_context_length` / `context_window` / `input_token_limit` / `max_model_len`）。优先级：`profile.contextWindow` → `modelContextWindows[model]` → 内置主流模型族映射表（Claude / GPT / Gemini / DeepSeek / Qwen / Llama 等）→ 安全默认值 `128_000`。
- **实测 token 优先 + 自适应估算兜底**：`agent_threads` 增量新增 `last_input_tokens` 与 `last_context_window`，每轮优先采用上游 `finish-step` 返回的真实 `usage.inputTokens`（同模型续聊时结合折叠差值与新增消息估算），缺失 `usage` 时回退中英文自适应 token 估算。
- **两级 80% 自动压缩（无手动压缩按钮）**：
  1. **第一级（零成本工具输出折叠）**：回放历史时保留最近 3 轮完整 `tool-result`，将更早轮次超长（>600 字符）只读工具返回折叠为紧凑摘要占位；同时在单轮长多步工具调用中通过 Vercel AI SDK `prepareStep` 折叠早期超大只读输出，防止单轮撞窗。始终保证消息序列从 `user` 开始且 `tool-call`/`tool-result` 严格成对。
  2. **第二级（80% 自动摘要压缩）**：若校准后总输入达到 `contextWindow * 0.80`，自动调用当前会话模型将较早完整回合总结为持久化结构化摘要（保留目标与约定、已查/改文件与行号、提案处置结果与未完事项），写入 `agent_threads.compaction_summary` 与 `compacted_up_to_message_id`，后续轮次以 `<session_compaction_summary>` 前缀 + 边界后的活跃消息起步；压缩调用失败时平滑降级为按完整回合对齐裁剪至 80% 以内，绝不阻断回答。

### 4. Frontend keep-alive shell, interleaved timeline & transparent context state

- **隐藏保活**：`apps/web/src/routes/Editor.tsx` 在书籍就绪后对右侧助手栏及拖拽分隔线改用 `hidden={!agentOpen}` 保活，收起面板不中断进行中的生成、重开保留原会话与输入草稿；流式生成期间输入框保持可编辑以提前起草（回车不触发发送，发送钮保持停止态）。
- **真实多步时间线**：`apps/web/src/ui/AgentPanel.tsx` 在流式期与历史加载期均按真实执行顺序交错渲染思考块、连续合并的工具步骤组与正文 Markdown 气泡（旧消息平滑兼容）。
- **轻量上下文与压缩可见度**：严格复用 `tokens.css` 既有语义 Token，在输入卡底栏右侧展示紧凑 `XX%` 上下文占用指示（≥70% 切 `--status-warn-fg/bg`，悬停显示精确 token / 上限），并在触发自动压缩的消息边界展示可折叠的「已自动压缩早期上下文」分隔条；`AgentProposalCard.tsx` 补齐 `superseded` / `reverted` 紧凑状态行；`AgentSettingsDialog.tsx` 增加可选「上下文窗口（tokens）」输入项。

## Alternatives considered

**改为回合内工具级挂起审批（Claude Code / Codex 风格），或混合双轨审批**。工具级挂起虽可在单个写工具前拦截，但需要服务端跨请求挂起/恢复状态机，且会打断多处校对流程并削弱刚落地的主画布整轮仿真书页三态审阅与逐 Hunk 审批体验；混合双轨则增加两套审批心智。最终选择保留回合末主画布审阅，并通过累计待审阅草稿与审批闭环实现连续会话体验。

**仅在历史文本里追加工具摘要，不持久化完整 `tool-call` / `tool-result` 消息链**。实现最轻，但模型在下一轮仍无法看到上一轮 `read_file` / `search_book` 读到的原文与行号，无法真正消除重复查书与失忆感。放弃。

**保留固定字符滑窗（或仅提高至固定 120K 字符）不做自动压缩，或额外提供手动 `/compact` 按钮**。固定字符上限无法适配本地 Ollama 8K/32K 与云端 200K/1M 的悬殊窗口差异；手动压缩增加心智负担，不如在 80% 窗口自动静默收敛（并附轻量可折叠提示）。放弃。

**仅靠内置模型名映射表估算上下文窗口，不在设置页提供覆写项**。对标准云端模型可用，但对本地 Ollama 与自定义别名中转无法准确命中真实窗口，易在触发 80% 压缩前直接撞上游 `context_length_exceeded`。采用三级自动识别 + 可选覆写。

**不叠加未应用的 `pending` 提案，强制用户先应用或放弃再继续对话**。在主画布边审阅书页修订边口头让 Agent 微调时，容易产生多张重叠冲突的待审阅提案卡，割裂感强。采用未漂移自动承接 + 替代标记 `superseded`。

**生成期间支持消息排队（Queue/Steer）或多会话并发后台生成**。Booksmith 为单书编辑工作台，多路并发写书易引发版本冲突与草稿覆盖，且队列管理大幅扩大前端复杂度。收敛为隐藏保活 + 流式期可提前起草 + 单会话串行。

## Consequences

**验收结果（2026-11-21）**

- 全仓类型检查与构建：`pnpm -r typecheck && pnpm -r build` 全部通过（`core` / `server` / `web` 2333 modules 均 0 错）。
- 核心与前端单测：`pnpm test` **39 个文件、326 条单测全部通过**（含 `packages/core/test/agentTools.test.ts` 12 条覆盖待审阅提案承接、累计 Diff、还原抵消与手动漂移检测）。
- 服务端集成测试：`pnpm --filter @booksmith/server test` **8 个文件、79 条测试全部通过**（含新增 `agentContext.test.ts` 4 条、扩充的 `agentRunner.test.ts` 12 条与 `agentRoutes.test.ts` 全链路多轮工具回放、累计提案替代、部分应用/撤销闭环与 80% 自动压缩测试）。
- 对比度、端到端与双主题视觉巡检：`check_contrast.py` 实测浅/暗 6 组新增元素语义配对均在 `5.29:1–8.43:1`；`pnpm exec playwright test e2e/agent.spec.ts` **2/2 通过**（覆盖侧栏收起保活不断流、流式期提前起草、交错时间线、未应用草稿叠加替代、80% 自动压缩分隔条与刷新持久化）；`node e2e/audit-shots.mjs` 输出 `audit: clean`（`1440px`/`400px` 浅暗双主题零横向溢出、零断图、零报错）。
- 待 PR Review 人工确认项：使用真实云端或本地模型配合样本书 `fixtures/马克思经济学与数理分析.epub` 体验连续多轮校对、审阅中追问微调与低窗口 80% 自动压缩效果。

**代价与已知限制**

- **上游中转 `usage` 缺失或波动**：部分第三方兼容中转在流式模式下不返回 `usage` 或返回 0；已通过中英文自适应 token 估算兜底保证 80% 阈值仍可触发，实际显示百分比在此类端点上为估算值。
- **弱模型自动压缩质量波动**：本地小模型可能生成偏长或超时的压缩结果；压缩调用设 45s 超时与输出上限，并具备失败即降级为完整回合对齐裁剪的安全底线。
- **隐藏保活的 DOM 驻留**：打开书籍期间 `AgentPanel` 保持挂载；切书（`bookId` 变化）或退出编辑页时仍会触发清理并中止活跃流，避免跨书串流。
- **纯增量数据库迁移**：迁移 `0009_sharp_ravenous.sql` 仅添加可空列（移除了 `drizzle-kit` 基于 `0008_snapshot.json` 自动生成的冗余 `DROP TABLE "book_files" CASCADE`，保持 `migrate.ts` 无损回填后再删旧表的不变量），完全兼容存量会话与消息记录。
