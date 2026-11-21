# ADR: Agent approval modes, multi-model providers, preferences, reasoning & retry

Status: implemented

## Problem

在 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 与 [the dedicated Agent sidebar chat UI](../design/2026-11-20-agent-sidebar-chat-ui.md) 落地后，日常重度校对与整书整理场景暴露出四类高频摩擦：

1. **同一供应商无法快捷切换多模型**：`agent_profiles` 将协议、Base URL、加密 API Key 与单个 `model` 绑定。用户在同一供应商（如 OpenAI、Anthropic、DeepSeek、OpenRouter 或本地 Ollama）下于快模型校对与强模型结构重构间切换时，必须重复新建预设并反复粘贴同一 API Key，且无法从端点自动拉取可用模型列表。
2. **单一审阅流程缺乏模式弹性**：此前每轮始终暴露全部 16 个读写工具并固定弹出 Diff 提案卡等待点击应用。纯咨询/审校时无法从工具层彻底阻止写入；高频批量微调或信任流程下，每轮都要重复点击「应用变更」，缺乏带安全底线的自动应用模式。
3. **缺少跨设备一致的运行偏好**：单轮最大工具步数固定为 15，且没有账号级自定义校对规范（如保留特定学术术语、标点与 MathML 约定）的持久化入口，换设备或开新对话只能反复在消息里重述。
4. **思考过程不可见且失败回复不便重试**：面对推理模型（Anthropic Extended Thinking、DeepSeek-R1 等），流式思考过程被丢弃，长思考期间用户只能看到静止的「正在思考…」；当某条助手回复报错、被中止或希望换更强模型重答时，只能复制提问重发并在记录里留下重复用户气泡。

## Decision

在保留 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 的服务端沙盒、即时 XML 校验、`validateStructure` 预检、AES-256-GCM 密钥加密与浏览器工作区单一保存路径，以及 [the Soft Craft Studio UI](../design/2026-11-20-soft-craft-studio-ui.md) 语义 Token 体系的前提下，增量扩展四组能力：

### Three-tier approval modes (`ask` / `review` / `auto`)

- **`ask`（只读顾问）**：`packages/core/src/agentTools.ts` 导出 `AGENT_READ_ONLY_TOOL_NAMES`（7 个只读工具：`list_files`、`read_file`、`search_book`、`lint_book`、`get_metadata`、`get_toc`、`scan_headings`）与 `isReadOnlyAgentTool()`。`apps/server/src/agent/runner.ts` 在 `ask` 模式下仅向 `streamText` 注册只读工具，并在 `systemPrompt.ts` 明确禁止写入，保证零提案产出。
- **`review`（审阅提案，出厂默认）**：沿用既有 16 工具沙盒与 Diff 提案卡人工审阅流程。
- **`auto`（自动应用）**：开放全部 16 工具；回合结束且经 `apps/web/src/state/agentProposal.ts` 的 `evaluateAutoApply` 通过安全门禁（`validateStructure` 零报错且无 `kind === 'delete'` 伴随 `referencesAffected.length > 0`）时，前端自动应用提案到浏览器内存工作区，同步记录一键「撤销本次应用」快照并沿用既有 `autosave` 与 `If-Match` 乐观锁路径；若触发预检报错或外链失效风险，自动降级保留 `pending` 卡片并在 `AgentProposalCard.tsx` 高亮降级原因由用户人工裁决。
- **持久化**：通过增量迁移 `apps/server/drizzle/0007_uneven_doctor_octopus.sql` 在 `agent_threads` 新增 `approval_mode` 列（默认 `'review'`，按会话持久化）；新建会话默认继承用户的云端 `default_approval_mode`。

### Multi-model providers on `agent_profiles`

- **数据模型**：在既有 `agent_profiles` 新增 `models_json` 列保存同一端点/密钥下启用的多个模型 ID（JSON 字符串数组，归一化去重且恒包含默认 `model`，上限 100 项，既有单模型预设自动兼容为 `[model]`）；在 `agent_threads` 新增可空 `model` 列记录会话当前选中模型（为空时回退绑定供应商的默认 `model`）。
- **服务端代理拉取模型**：`apps/server/src/agent/providers.ts` 提供 `fetchProviderModels`，由 `POST /api/agent/profiles/models` 暴露，复用服务端解密后的 API Key（支持传 `profileId` 或未保存表单参数）向 OpenAI-compatible（`GET {baseUrl}/models`，兼容 Ollama `models[].name`）或 Anthropic（`GET {normalized}/models`）拉取候选模型列表（10s 超时）；拉取失败时返回友好提示，不阻断手动增删模型与指定默认模型。
- **底栏双紧凑胶囊交互**：`apps/web/src/ui/AgentPanel.tsx` 输入卡底栏左侧并排放置 `[模式 ▾]`（`auto` 态采用 `--status-warn-bg` / `--status-warn-fg` 搭配闪电图标显式警示，`ask`/`review` 采用中性胶囊）与 `[当前模型 ▾]`（Radix `DropdownMenu` 按供应商分组展示多模型，总模型数 `> 8` 显示搜索过滤输入），右侧保留发送/停止圆钮，在 `400px` 与 `1440px` 视口保持零横向溢出。

### Cloud-synced user preferences (`agent_user_settings`)

- Postgres 新增 `agent_user_settings` 表（`user_id` 主键外键级联删除、`default_approval_mode` 默认 `'review'`、`max_steps` 默认 `15`，接受任意正整数或 `0`/留空表示不限制、`custom_instructions` 上限 4000 字默认 `''`、`updated_at`）。
- `apps/server/src/routes/agent.ts` 提供 `GET /api/agent/settings` 与 `PATCH /api/agent/settings`，`apps/web/src/ui/AgentSettingsDialog.tsx` 在「应用设置 → AI 助手」顶部提供「运行偏好」区（默认审批模式三选一、单轮最大工具步数自由数字输入框/留空不限、自定义附加指令文本框）。服务端执行对话与重试回合时直接读取该用户偏好，当 `maxSteps > 0` 时通过 `stepCountIs(maxSteps)` 控步、`maxSteps === 0` 时使用 `() => false` 不限步数，并将非空 `customInstructions` 注入系统提示词末尾。

### Reasoning trace & last-turn retry

- **思考过程**：`agent_messages` 新增可空 `reasoning` 列；`runner.ts` 消费 Vercel AI SDK `fullStream` 中的 `reasoning-delta` 事件，推送 `{ type: 'reasoning_delta', text }` SSE 事件并落库，同时 `trimHistory` 发送给模型的历史上下文有意省略旧轮次 `reasoning`（避免思维链撑爆 24,000 字符滑窗）。前端 `AgentPanel.tsx` 在助手气泡上方以默认折叠的 `ReasoningBlock` 展示（流式思考中显示动态状态，正文输出开始后自动收起并允许展开，展开区限高 `280px` 独立滚动）。
- **末条助手重试**：新增 `POST /api/books/:id/agent/threads/:threadId/messages/:messageId/retry`（SSE 流）。服务端校验目标消息是该会话最后一条且为助手消息、且 `proposalStatus !== 'applied'`（已应用返回 `409 proposal_already_applied`），使用紧邻前一条用户消息及其上下文和本次请求指定的 `profileId` / `model` / `approvalMode` 重新生成并原地更新该条助手消息，避免产生重复用户气泡。

## Alternatives considered

**在三档模式基础上增加工具执行前挂起式逐步审批（Step-by-step approval）**。可在单个写工具调用前拦截，但需要服务端维护内存挂起会话、超时回收与跨请求唤醒回调（多进程不共享），且 EPUB 校对常连续调用多步写工具，频繁暂停打断体验；沿用 [the built-in EPUB Agent](2026-11-20-builtin-epub-agent.md) 的沙盒预检 + 前端一键撤销已提供充分安全兜底。放弃。

**自动应用模式仅允许纯文本修改，结构变更一律退回手动审阅**。更保守，但用户选择自动模式时整理目录、新建章节或重命名仍需每次多点一次确认；结合 `validateStructure` 预检阻断、删除引发外链失效自动降级以及一键整批撤销，已足以守住结构安全。放弃。

**拆分全新的 `agent_providers` 与 `agent_models` 两张表替代 `agent_profiles`**。概念上最规范，但需迁移存量数据并重写全部 Profile 接口与测试，超出个人/小团队自托管工作台的需求复杂度；在 `agent_profiles` 增量添加 `models_json` 可零破坏演进并完全解决复用 API Key 的痛点。放弃。

**将审批模式移至 38px 顶栏，底栏仅留模型切换器**。顶栏已排布历史会话标题、新建、设置与关闭按钮，再放模式胶囊会严重挤压长会话标题，且远离输入与发送区导致发消息前容易忽略当前处于「自动」或「只读」模式。采用输入卡底栏双紧凑胶囊。

**将默认审批模式、最大步数与自定义指令仅存于浏览器 `localStorage`（`settingsStore`）**。零后端表结构改动，但换浏览器或换设备编辑时会丢失精心整理的校对规范与默认偏好。采用 Postgres `agent_user_settings` 账号级同步。

**对单轮最大工具步数施加 `5–30` 固定步进区间限制**。初始草案曾采用步进器限制 `5–30` 步，但整本多章 EPUB 校对轻松超过 30 次工具调用，人工上限不符合真实编书工作流。在验收前根据用户反馈取消区间限制，改为自由输入任意正整数或留空不限（`0`）。

**支持编辑任意历史用户消息并截断后续分支重发**。灵活性更高，但截断历史时若中间包含已应用到工作区的提案，会造成书稿状态与对话审计历史严重失真。首期收敛为「仅允许重试最后一条且未应用的助手消息」。

## Consequences

**验收结果（2026-11-20 / 2026-11-21）**

- 全仓类型检查、构建与自动化单测/集成测试全部通过：`pnpm -r typecheck` 与 `pnpm -r build`（`core` / `server` / `web` 2314 modules）均 0 错；`pnpm test` 26 个文件、251 条单测通过（含 `agentTools.test.ts` 10 条、`agentProposal.test.ts` 4 条、`tokens.test.ts` 53 条）；`pnpm --filter @booksmith/server test` 6 个文件、61 条集成测试通过（含 `agentRunner.test.ts` 8 条与 `agentRoutes.test.ts` 全链路多模型/设置/思考/重试测试）。
- 视觉对比度与巡检通过：`check_contrast.py` 实测 `auto` 警示胶囊 `--status-warn-fg` / `--status-warn-bg` 对比度为 `5.29:1`（浅色）与 `7.20:1`（暗色）；`node e2e/audit-shots.mjs` 输出 `audit: clean`（`1440px` / `400px` 浅暗双主题零横向溢出、零断图、零报错）。
- 端到端测试与用户验收：[e2e/agent.spec.ts](../../../../e2e/agent.spec.ts) 与 `e2e/settings.spec.ts` 全部通过（覆盖同供应商拉取多模型、底栏分组切换、自由输入最大步数 `80`、自定义指令、三档审批模式与撤销、思考块展开、失败换模型重试与 `1440px`/`400px` 零溢出）；用户已在本地预览环境中完成人工验收确认。
- **已豁免的既有测试缺口（waived by user, 2026-11-21）**：全量 `pnpm exec playwright test` 通过 74/75，唯一失败为与本次改动无关的既有目录测试 `e2e/panels.spec.ts:43`（`renames a toc entry and mirrors it into the ncx` 仍按旧单击 `.toc-label` 进入行内编辑预期编写），经用户确认豁免不阻断本次交付。

**代价与已知限制**

- **上游 `/models` 协议碎片化**：部分第三方 OpenAI 兼容中转未实现 `/models` 或返回非标准字段，已通过 10s 超时、兼容 `{ data: [{ id }] }` 与 Ollama `{ models: [{ name }] }` 响应格式以及始终允许手动增删模型缓解，拉取失败不阻断保存。
- **推理字段方言差异**：依赖 Vercel AI SDK `fullStream` 将 OpenAI-compatible `reasoning_content`/`reasoning` 与 Anthropic `thinking_delta` 统一映射为 `reasoning-delta`；未采用标准流式字段的中转站会平滑降级为不展示思考块。
- **无上限步数的停止依赖**：当用户将单轮最大工具步数留空（不限制）或设得极大时，若模型陷入重复调用循环，需要用户主动点击输入卡右下角的停止按钮中止生成。
- **纯增量数据表演进**：迁移 `0007_uneven_doctor_octopus.sql` 为纯增量加列与新增 `agent_user_settings` 表，不破坏存量预设与历史会话。
- **后续会话连续性演进（2026-11-21）**：本文档中历史回放仅保留纯文本、不带工具轨迹与提案处置状态的条款已由 [continuous multi-turn Agent sessions](2026-11-21-agent-session-continuity.md) 部分替代；三档审批模式、同供应商多模型、云端运行偏好、流式思考块与末条重试机制保持有效。
- **后续消息流与思考展示演进（2026-11-22）**：本文档中独立 `ReasoningBlock` 流式自动展开展示形态已由 [flat editorial Agent messages with unified collapsible process drawer](../design/2026-11-22-agent-chat-process-drawer-ui.md) 部分替代，升级为统一过程折叠抽屉与逐块隔离思考态；三档审批模式、同供应商多模型、云端运行偏好与末条重试机制保持有效。
