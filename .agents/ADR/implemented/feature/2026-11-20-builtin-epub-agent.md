# ADR: Built-in single-book EPUB Agent

Status: implemented

## Problem

Booksmith 的核心使用场景是在浏览器三栏工作台中对整本 EPUB（如含 25 章、单章 174KB、328 个内联 `<math>` 与双目录结构的学术书籍）进行精细校对、样式修复与结构整理。此前所有文本校对、批量语义修改、结构错误排查、OPF 元数据与目录整理，以及章节重命名和删除，都依赖用户手工定位与逐处编辑。

直接接入外部大模型存在四类真实约束：

1. **编辑期真相在浏览器内存中**：依据 [the server-backed EPUB architecture](../architecture/2026-11-19-server-backed-epub-editor.md)，用户在保存前的所有修改暂存在浏览器内存与 IndexedDB 草稿中，Postgres 仅存上次落库的整包字节；若 Agent 直接读库，会基于陈旧内容提出冲突或破坏性修改。
2. **EPUB 保真与结构一致性要求高**：未修改条目须字节等价，章节含内联 MathML 与命名空间声明，且文件重命名、删除、OPF 与双目录（`nav.xhtml` / `toc.ncx`）存在跨文件引用级联，部分应用或非法 XML 会导致整书损坏。
3. **多用户自托管的模型凭据与成本隔离**：Booksmith 面向个人或小团队（`ALLOWED_EMAILS` 白名单）自托管，不同用户需要配置自己的模型服务与多套预设（如快模型校对、强模型重构，或本地 Ollama 端点），同时严禁明文落库 API Key 或引入破坏「一份 `pg_dump` + 环境变量 = 完整备份」的隐藏本地密钥文件。
4. **三栏精密工作台的空间约束**：依据 [the precision workbench UI system](../design/2026-11-20-precision-workbench-ui.md)，工作台由左侧文件树（`240px`）、自适应编辑区与右侧栏（`400–560px`）构成，新增交互不能挤垮代码区或引入脱离既有语义 Token 体系的视觉噪音。

## Decision

在 Booksmith 编辑器内构建聚焦当前单书的交互式 Web Agent，以「同构 EPUB 工具原语 + 服务端双协议流式循环 + 前端 Diff 提案审阅」闭环运行。

### Core tool layer & workspace overlay

在 `packages/core/src/agentTools.ts` 中提供框架无关的 `AgentWorkspace` 与 13 个同构工具原语（不绑定任何 AI SDK，保留日后直接复用为外部 MCP Server 的清晰边界）：

- **只读工具**：`list_files`、`read_file`（默认 200 行、上限 400 行 / 24KB 分段读取并回报总行数，避免 174KB 单章撑爆上下文）、`search_book`（默认 40、上限 100 条截断）、`lint_book`（复用结构检查与断链检测）、`get_metadata`、`get_toc`。
- **写入工具**：`edit_file`（精确片段替换）、`write_file`（整文件覆写已有文本文件）、`update_metadata`、`update_toc`（同步 `nav.xhtml` 与 `toc.ncx` 并在跨目录时重算相对路径）、`create_chapter`、`rename_file`（复用 [file structure editing](2026-11-19-file-structure-editing.md) 的引用与 manifest/TOC 级联重写）、`delete_file`（级联移除 manifest/spine/TOC 条目并回报受影响引用，禁止删除 OPF 与 `nav.xhtml`）。

每次对话请求时，前端上报当前书的 `baseVersion`、未保存的 `dirtyTexts` 与相对服务端已删的 `deletedPaths`（由 `LoadedBook.serverPaths` 计算）。服务端校验 `baseVersion`（不匹配返回 `409`），从 `book_files` 解包并叠加前端脏状态构建回合内 `AgentWorkspace`。每一步写工具都即时校验 XML 良构性（服务端由 `apps/server/src/agent/nodeXmlCodec.ts` 的 `@xmldom/xmldom` 执行），出错时回滚该步并将错误回传给模型自纠；回合结束前运行 `validateStructure` 预检并产出可序列化的 `AgentProposal`。

### Proposal review, application granularity & undo

所有写操作以 `AgentProposal` 形式随助手回合返回，在 `apps/web/src/ui/AgentProposalCard.tsx` 中复用 [document diff](2026-11-19-document-diff.md) 的字符级 `diffLines` 逐文件展示紧凑上下文 Diff（支持大 Diff 展开全文）：

- **纯文本提案**（仅修改现有文本文件内容）：允许用户在审阅时按文件勾选应用或跳过。
- **结构变更提案**（包含新建、重命名、删除文件，或涉及 OPF / 目录改动）：标注为「结构变更 · 整批应用」，作为通过 `validateStructure` 预检的原子包整体应用或整体放弃；预检失败时阻断应用并展示诊断列表。
- **落入浏览器工作区与回滚**：`apps/web/src/state/agentProposal.ts` 的 `applyProposalToBook` 只更新浏览器内存工作区（同步 `archive`、`pkg`、`texts`、`groups`、`dirty`、`tabs`、`active` 与 IndexedDB 草稿），同时通过 `createUndoSnapshot` 记录一次整批撤销快照（「撤销本次应用」）；后续落库沿用现有手动/自动保存、乐观锁（`If-Match`）与 [page-level snapshots](2026-11-19-page-level-snapshots.md)。

### Per-user model profiles, encryption & SDK boundary

- **多预设管理与加密存储**：Postgres 通过迁移 `apps/server/drizzle/0006_vengeful_energizer.sql` 新增 `agent_profiles` 表，按 `userId` 保存多套预设（名称、协议 `openai-compatible` / `anthropic`、Base URL、Model、是否默认、`apiKeyCiphertext`、`apiKeyLast4`）。前端在 `apps/web/src/ui/AgentSettingsDialog.tsx`（基于 Radix `Dialog`，`width: min(760px, calc(100vw - 32px))` 双栏）提供预设 CRUD、设为默认、OpenAI / Anthropic / DeepSeek / Ollama 快捷模板与实时连通性测试，并在对话输入栏提供模型下拉切换。
- **主密钥策略**：服务端在 `apps/server/src/agent/crypto.ts` 中通过环境变量 `AGENT_SECRET_KEY`（32 字节 hex 或 base64/base64url）以 AES-256-GCM 加密用户 API Key（密文格式 `v1:<iv>:<tag>:<ct>`）。未配置 `AGENT_SECRET_KEY` 时服务照常启动、纯编辑功能不受影响，仅在保存或读取含 API Key 的预设时返回 `503 agent_secret_not_configured`；本地无 Key 端点（如 Ollama）允许空 Key 保存。Base URL 校验仅允许 `http:` / `https:` 协议（允许本机/内网地址以支持自托管模型，信任边界同 `ALLOWED_EMAILS` 内部白名单）。
- **流式运行时**：`apps/server` 引入 Vercel AI SDK 核心包（`ai@^7.0.177`、`@ai-sdk/openai-compatible@^3.0.93`、`@ai-sdk/anthropic@^4.0.106`、`zod@^4.6.7`），在 `providers.ts` 与 `runner.ts` 中驱动双协议流式解析、工具参数校验与多步循环（`stopWhen: stepCountIs(15)` + `abortSignal`）。`apps/server/src/routes/agent.ts` 劫持响应直接输出自有轻量 SSE 事件（`text_delta` / `tool_start` / `tool_end` / `proposal` / `done` / `error`），关闭代理缓冲（`X-Accel-Buffering: no`），并在持久化助手消息后才发送带真实 `messageId` 的 `done` 事件。

### Workbench placement & thread persistence

- **右侧栏停靠与面板形态**：首版作为右侧栏第 6 Tab「助手」交付；后续已由 [the dedicated Agent sidebar chat UI](../design/2026-11-20-agent-sidebar-chat-ui.md) 部分替代，抽离为顶栏一键开关的独立可折叠右侧 Agent 侧边栏（全屏宽与 5-Tab 预览/结构栏互斥，并升级为 IM 左右气泡对话流、Markdown 渲染、Radix Popover 历史会话管理与底部一体化输入卡）。
- **按书多会话持久化**：Postgres 新增 `agent_threads` 与 `agent_messages` 两张增量表（外键级联删除，`agent_threads.profile_id` 在删预设时 `ON DELETE SET NULL` 保留历史会话），支持每本书新建、切换、删除对话，保留工具步骤摘要与提案状态（`pending` / `applied` / `dismissed`），调用模型时通过 `trimHistory` 对长历史施加 24,000 字符滑窗裁剪。

## Alternatives considered

**仅对外暴露 MCP Server / API，不做网页内置 Agent**。能复用外部 Coding Agent（如 Claude Code / Codex）并免去自建对话 UI 与模型配置，但脱离编辑器实时预览与选中片段联动，每次校对都要切换工具且难以处理浏览器未保存草稿。放弃作为首期方案；通过把工具原语抽在 `packages/core/src/agentTools.ts` 为后续扩展 MCP 保留入口。

**首期同时交付内置 Web Agent 与外部 MCP Server**。两端同时落地会使鉴权、并发冲突（浏览器内存草稿 vs 外部直写服务端）与测试面成倍膨胀，不适合作为单次交付。放弃。

**包含整书级后台批处理流水线（如整书翻译/断点续跑）或跨书库全局 Agent**。后台批处理需要持久化作业队列、状态恢复与成本控制；跨书库需要多书索引与跨书上下文隔离。两者均超出日常单书校对与结构整理的核心高频场景，延后至后续独立评估。

**只读顾问模式，或工具箱不包含重命名与删除**。只读模式迫使用户手工复制粘贴；限制在纯文本或禁止删改名会令 Agent 无法完成章节文件重组、清理冗余页面等真实编书任务。因此选择完整读写工具箱，并通过提案原子应用与结构预检兜底安全。

**服务端环境变量统一配单模型，或网页端仅维护单组配置**。纯环境变量无法满足多用户自管额度与网页即时切模型；单组配置无法在快模型校对与强模型重构之间随手切换。采用网页端按用户多预设管理。

**未配置 `AGENT_SECRET_KEY` 时在本地自动生成密钥文件**。虽可实现本地零配置，但容器化部署若遗漏挂载该文件会导致重建后库内已加密 Key 全部无法解密，并破坏现有「一份 `pg_dump` 就是全量备份」的运维模型。放弃。

**写操作直接落入工作区，或全部提案强制整包应用，或结构操作中途挂起审批**。直接写入在含复杂 MathML 校对时容易静默改坏且难以发现；一律整包应用会使纯文本多章校对无法跳过单章；工具执行前挂起审批会频繁打断长流程并引入服务端暂停/恢复状态机。因此采用「纯文本按文件勾选 + 结构变更整包原子应用」。

**独立第四栏抽屉或居中浮层弹窗**。第四栏会在 `1280–1440px` 屏幕上严重挤压代码区并增加分割线与移动端复杂度；居中浮层会遮挡正文无法对照源码校对。采用右侧栏第 6 Tab「助手」。

**仅前端内存保留对话历史**。实现最轻，但长书往往分多天、多设备校对，刷新即丢上下文体验割裂。采用按书持久化至 Postgres。

**原生 Node `fetch` 全手写双协议 SSE，或双官方 SDK（`openai` + `@anthropic-ai/sdk`）自写消息转换层，或引入 LangChain / Mastra 等重型框架**。在允许用户自配任意 OpenAI-compatible 中转与 Anthropic 的前提下，纯手写流式分片与边缘兼容维护成本过高；双官方 SDK 仍需维护两套消息/工具双向转换；重型编排框架黑盒过重。因此采用 Vercel AI SDK 核心包仅作协议与多步工具循环层，核心 EPUB 工具层保持零框架耦合。

## Consequences

**验收结果（2026-11-20）**

- 全仓类型检查与自动化测试全部通过：`pnpm -r typecheck`（`core` / `web` / `server` 均 0 错）；`pnpm vitest run` 20 个文件、201 条单测通过（含 `agentTools.test.ts` 8 条、`agentProposal.test.ts` 3 条、`tokens.test.ts` 51 条）；`pnpm --filter @booksmith/server test` 6 个文件、57 条集成测试通过（含 `agentCrypto.test.ts` 6 条、`agentRunner.test.ts` 5 条、`agentRoutes.test.ts` 2 组全链路接口与 SSE 测试）。
- 真实样本书（`fixtures/马克思经济学与数理分析.epub`）验证通过：`edit_file` 基于局部字符串替换保持未修改章节及 `<math>` 字节等价，OPF 修改后重新打包可通过服务端 `ingestEpub` 校验。
- 全量端到端与视觉审计通过：`pnpm playwright test` 67/67 通过（含新增 `e2e/agent.spec.ts`）；`node e2e/audit-shots.mjs` 输出 `audit: clean`（`1440px` / `400px` 浅暗双主题零横向溢出、零断图、零报错）。
- 用户已在本地运行环境下完成人工验收确认。

**代价与已知限制**

- **自定义 Base URL 的内网访问面**：为支持用户自建 Ollama / vLLM，服务端放行 `http:`/`https:` 本机与内网地址。该前提严格依赖 Booksmith「受信任内部白名单用户（`ALLOWED_EMAILS`）、不对外提供公共 SaaS」的部署模型；若未来对外公开注册，必须增加私有网段 SSRF 拦截与显式白名单。
- **服务端新增依赖**：`apps/server` 引入了 `ai`、`@ai-sdk/openai-compatible`、`@ai-sdk/anthropic`、`zod` 四个依赖；核心 EPUB 工具原语仍保留在 `packages/core` 中与 SDK 解耦。
- **主密钥运维要求**：使用云端 API Key 的部署必须持久保存环境变量 `AGENT_SECRET_KEY`，变更该密钥会导致既有加密 API Key 无法解密，需用户重新录入；表结构为纯增量三表（`agent_profiles`、`agent_threads`、`agent_messages`），不影响既有书籍与快照数据。
- **长对话与大章节预算控制**：当前单工具读窗保持上限（`read_file` 400 行 / 24KB、`search_book` 100 条）；原 `trimHistory` 24,000 字符纯文本滑窗与每轮独立一次性沙盒条款已由 [continuous multi-turn Agent sessions](2026-11-21-agent-session-continuity.md) 部分替代，升级为跨协议完整工具轨迹持久化、未应用待审阅提案自动承接与基于模型上下文窗口 80% 的两级自动压缩；单轮最大工具步数默认 15，已由 [Agent approval modes, multi-model providers, preferences, reasoning & retry](2026-11-20-agent-modes-and-multimodel.md) 扩展为可按账号云端自定义（支持任意正整数或留空不限）。
- **主画布审阅与逐处审批演进**：本文档中的「侧栏 `AgentProposalCard` 内嵌窄栏 Diff 与纯文本仅按文件勾选」条款已由 [in-canvas EPUB Agent proposal review](2026-11-21-in-canvas-agent-proposal-review.md) 部分替代，升级为中央主编辑区原位三态审阅（`修订 / 终稿 / 源码`）与纯文本逐处变更块（Hunk）审批；「仅回合末推送 `proposal` 及中止丢弃沙盒变更」条款进一步由 [real-time streaming Agent review with Cursor-style 3-state hunk approval](2026-11-22-live-streaming-agent-review.md) 部分替代，升级为 `review` 模式写工具实时增量流式推送与软中止保留已改提案。核心工具层、服务端沙盒、结构变更原子应用与浏览器工作区单一保存路径保持有效。
