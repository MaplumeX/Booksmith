# ADR: Dedicated Agent sidebar with IM-bubble chat UI

Status: implemented

## Problem

在 [the built-in EPUB Agent](../feature/2026-11-20-builtin-epub-agent.md) 首版落地后，助手界面被塞在右侧栏第 6 个 Tab（「助手」）内部，且沿用了表单式工具栏与纯文本消息流，实际使用中暴露出四类体验短板：

1. **入口埋藏与双层叠头**：右侧栏顶部已并排 6 个小 Tab，进入「助手」后下方又叠加一整条灰底工具栏（原生会话 `<select>` + 常驻删除按钮），消耗超过 80px 顶部高度，缺乏独立软件侧边栏 Agent 的专属感。
2. **输入区割裂且上下文不可恢复**：灰色底栏里堆砌独立浮出的上下文芯片、带垂直拖拽把手的 `<textarea>` 与拉满宽度的原生模型 `<select>`，移除当前文件或选区上下文后没有重新挂载路径。
3. **消息流可读性不足**：助手回复使用纯文本 `pre-wrap`，完全不渲染 Markdown（粗体、列表、代码片段与表格均以原始符号显示）；每条消息顶部重复印出「你 / 助手」标签；工具调用展示为 4 列英文函数名表格，在 400–440px 栏宽里严重截断。
4. **提案卡片与设置弹窗控件质感偏重**：`AgentProposalCard` 在窄栏内呈盒中套盒观感；`AgentSettingsDialog` 仍使用原生接口协议 `<select>`，左侧预设卡片与表单层次偏平。

## Decision

部分替代 [the built-in EPUB Agent](../feature/2026-11-20-builtin-epub-agent.md) 中的「右侧栏第 6 Tab 停靠位置与 Agent 面板界面契约」条款（该记录中的核心工具层、工作区 Overlay、密钥加密、流式运行时与提案原子应用约束保持有效），在严格遵守 [the precision workbench UI system](2026-11-20-precision-workbench-ui.md) 语义 Token 体系的前提下，将 Agent 升级为独立可折叠的右侧 IM 气泡对话侧边栏，并同步精修模型设置弹窗。

### Design Thesis

- **Visual**：承接冷灰 + 墨蓝精密桌面校对工作台，以右对齐实心墨蓝用户气泡（`--accent` / `--accent-fg`）和左对齐头像冷灰助手气泡（`--surface-raised`）确立清晰对话节奏；使用 `--surface-elevated` 一体化悬浮输入卡与 Radix 浮层消除原生表单拼接感。
- **Content**：维持三栏工作台尺寸（左文件树 `240px` / 自适应主区，代码全宽、`WysiwygPane` 纸面维持 `max-width: 760px` / 右侧栏 `400–560px`），顶栏右侧常驻「助手」图标开关（`Mod+Shift+L`），在所有屏宽下与「预览/结构」侧栏互斥切换（`<1024px` 作为覆盖抽屉互斥展开）；预览/结构侧栏恢复 5 个 Tab，为后续独立重构保持零耦合。
- **Interaction**：Radix `Popover` / `DropdownMenu` 接管历史会话与模型切换（支持键盘导航与碰撞回拉）；动效仅使用 `transform` / `opacity`（`120–160ms`，`prefers-reduced-motion` 下仅保留透明度）；输入区随文本自动增高（1–6 行）并去除拖拽把手。

### Token Additions & Contrast

在 `apps/web/src/styles/tokens.css` 新增两个语义 Token，受 `apps/web/src/styles/tokens.test.ts` 与 `.agents/skills/mm-ui/scripts/check_contrast.py` 浅/暗对比度守卫（全部文本/背景配对 ≥ 4.5:1 且禁用 `#000`）：

| Token | 浅色 (`:root`) | 暗色 (`[data-theme='dark']`) | 实测对比度 / 用途 |
|---|---|---|---|
| `--accent-fg-muted` | `#eff5fa` | `#19334c` | 实心强调用户气泡内的上下文胶囊与次级文案；配 `--accent` = `5.90:1`（浅）/ `5.38:1`（暗），避免在有色底上使用灰字或降 `opacity` |
| `--bubble-radius` | `12px` | `12px` | 对话气泡主圆角（气泡收尾角配合 `--radius-sm` 形成 `12px 12px 4px 12px` / `12px 12px 12px 4px` 方向感） |

### Component Contracts & State Matrix

- **`Editor.tsx` 侧栏壳层**：将 `'agent'` 移出 `SIDEBAR_TABS`（恢复 5 Tab）；顶栏右侧提供「助手」图标开关（`aria-pressed`）与 `Mod+Shift+L` 快捷键；`agentOpen` 开启时右侧 `<aside className="sidebar is-agent">` 直接渲染全高 `AgentPanel`（不渲染 `.sidebar-tabs`）并透传 `onClose`；`<1024px` 下通过 `.shell.agent-open` 与移动端抽屉状态互斥。
- **`AgentMarkdown`（`apps/web/src/ui/AgentMarkdown.tsx`）**：零依赖安全 React Markdown 渲染组件（杜绝 `dangerouslySetInnerHTML`），支持标题、段落、加粗/斜体/删除线、行内代码、带语言标签与一键复制按钮的围栏代码块、有序/无序列表、引用块、独立横向可滚动 GFM 表格、`http:`/`https:` 安全链接以及流式未闭合代码块。
- **`AgentPanel`（`apps/web/src/ui/AgentPanel.tsx`）**：
  - `38px` 单行顶栏（与 `TabBar` 等高对齐）：左侧会话标题按钮触发 Radix `Popover` 历史会话列表（展示全部会话与时间、当前选中高亮、行内重命名调用 `api.updateAgentThread`、二次点击确认删除）；右侧仅留「新建对话 `+`」「模型预设设置」「关闭 `×`」三个图标按钮。
  - 消息流：用户气泡右对齐（`max-width: 85%`，实心 `--accent` 底，顶部可嵌入同色系上下文标签，底部显示时钟时间）；助手气泡左对齐（`24px` 圆角图标头像 + `--surface-raised` 卡片，内含 `AgentMarkdown` 与悬停/聚焦可见复制按钮及时间）。
  - 工具步骤（`ToolSteps`）与提案卡（`AgentProposalCard`）：均位于气泡外通栏左对齐，不塞进气泡内；13 个工具名映射为中文语义动作摘要，默认折叠为单行状态条，点击展开详情。
  - 底部一体化悬浮输入卡：顶部上下文胶囊支持点 `×` 移除与一键重挂当前文件/选区；中间无边框自动增高 `<textarea>`；底栏左侧 Radix `DropdownMenu` 模型预设菜单（含「管理模型预设…」快捷项，保留 `aria-label="选择模型预设"`），右侧圆形图标发送/停止按钮。
- **`AgentProposalCard`（`apps/web/src/ui/AgentProposalCard.tsx`）**：通栏轻量 changeset 卡片，文件行计算并展示等宽 `+N / -M` 变更统计，精简头尾视觉重量；保持纯文本按文件勾选、结构变更原子整批应用、预检阻断与「撤销本次应用」契约不变。
- **`AgentSettingsDialog`（`apps/web/src/ui/AgentSettingsDialog.tsx`）**：以 `role="radiogroup"` 二选一分段控件（`OpenAI 兼容` / `Anthropic 原生`）替代原生 `<select>`；补充 API Key 显隐切换、快捷模板激活反馈、左侧预设卡片协议徽标与表单分组间距调优。

| 组件 | default | empty | loading | error | edge |
|---|---|---|---|---|---|
| `AgentPanel` | 单行顶栏 + 左右气泡 Markdown + 紧凑中文工具行 + 悬浮输入卡 | 未配模型：`EmptyState` 引导；无消息：居中徽章 + 3 张快捷建议卡 | 气泡骨架屏；流式动态状态 + 圆形停止按钮 | 顶/底内联可操作错误条（重载 / 打开设置） | 长标题截断 + title；移除上下文后可重挂；`<1024px` 互斥抽屉零溢出 |
| `AgentMarkdown` | 标题/列表/代码/表格/安全链接 | 空串返回 `null` | 流式未闭合代码块不崩溃 | 非 `http(s)` 链接降级纯文本 | 宽表格与长代码块独立横向滚动不撑破气泡 |
| `AgentProposalCard` | 通栏轻量卡 + `+N/-M` 统计 + 折叠 Diff | 无差异提示 | 应用中按钮禁用 | 结构预检失败阻断并列诊断 | 已应用单行撤销；已放弃低对比单行；大 Diff 展开全文 |
| `AgentSettingsDialog` | 左列表 + 右分段协议与分组表单 | 无预设提示 + 直接创建 | 列表骨架 + 测试/保存旋转态 | 缺密钥警告 + 内联错误 | 留空保留已存密钥；删除二次确认；`<720px` 单栏堆叠 |

## Alternatives considered

**保留 Agent 在右侧栏第 6 个 Tab「助手」内**。无需修改 `Editor.tsx` 壳层，但顶部始终保留 6-Tab + Agent 工具条的双层叠头，视觉和心智上仍像附属标签页而非独立侧边栏对话助手。放弃。

**宽屏（`>= 1520px`）支持四栏并排、「预览/结构」与「助手」同屏共存**。在大屏下可并排对照预览与对话，但「预览/结构」栏后续将独立重构，提前耦合四栏分栏与自动折叠状态会增加迁移包袱。放弃，改为全屏宽互斥切换。

**采用无气泡的工作台流式文档风（Cursor / Copilot 风格）**。在窄栏内横向空间利用率略高，但视觉偏命令行/日志流，不如左右气泡+头像+时间戳直观贴近用户期望的软件侧边栏对话体验。放弃。

**使用柔和浅强调底（`--accent-subtle`）做用户气泡，或将工具步骤与 Diff 提案卡包进助手气泡内**。浅强调底在冷灰画布上左右区分度偏弱；将 Diff 卡塞进气泡会损失约 60px 横向宽度，导致窄栏代码 Diff 严重折行。采用实心 `--accent` 用户气泡 + 气泡外通栏工具/Diff 卡。

**侧边栏内切页式历史会话视图，或保留原生 `<select>`**。切页式多一次页面跳转且打断当前对话上下文；原生 `<select>` 视觉陈旧且无法承载行内重命名与删除。采用顶栏 Radix `Popover`。

**引入第三方 Markdown 渲染依赖（如 `react-markdown`）**。会增加前端包体积与依赖树；EPUB 校对助手回复所需的 Markdown 子集明确，自研零依赖纯 React 元素渲染器即可满足且天然免疫 `dangerouslySetInnerHTML` XSS 风险。

## Consequences

**验收结果（2026-11-20）**

- 全仓类型检查、构建与单测全部通过：`pnpm -r typecheck` 与 `pnpm -r build`（`core` / `web` / `server` 均 0 错）；`pnpm test` 22 个文件、211 条单测通过（含 `tokens.test.ts` 53 条浅/暗 ≥4.5:1 对比度与完整 token 断言、`AgentMarkdown.test.ts` 4 条解析与 XSS 协议拦截断言）；`check_contrast.py` 实测用户气泡全部配对 `5.38:1–6.56:1`。
- 全量端到端与视觉巡检通过：`pnpm exec playwright test` 69/69 通过（含更新后的 `e2e/agent.spec.ts`：顶栏开关、Markdown 渲染、上下文移除/重挂、Radix 模型下拉、历史 Popover 行内重命名与刷新持久化、1440px/400px 零溢出）；`node e2e/audit-shots.mjs` 输出 `audit: clean`。
- 用户已完成浅/暗双主题渲染截图及整体交互的验收确认。

**代价与已知限制**

- **自定义 Markdown 子集边界**：`AgentMarkdown.tsx` 覆盖标题、段落、行内样式/代码、可复制围栏代码块、列表、引用、GFM 表格与 `http(s)` 链接，不支持任意内嵌原生 HTML 标签渲染（有意降级为纯文本以杜绝 XSS）；遇到极端复杂嵌套列表时可能退化为平级条目，但不会丢失内容。
- **右侧栏全屏宽互斥**：为避免提前耦合待重构的「预览/结构」栏，当前在超宽屏下也仅显示「预览/结构」或「助手」其一；待预览/结构栏重构完成后，可在此基础上平滑评估宽屏并排模式。
- **移动端顶栏压缩**：在 `<= 560px` 视口下，顶栏「助手」按钮隐藏文字仅保留 `Sparkles` 图标（保留 `aria-label="助手"`），未保存角标 `.appbar-flag` 交由底部 `StatusBar` 承担，以守住 `400px` 零横向溢出。

**后续演进（2026-11-20）**

- 右侧 5-Tab「预览/结构」侧栏已由 [the Soft Craft Studio UI decision](2026-11-20-soft-craft-studio-ui.md) 彻底拆解移除（目录并入左栏、查找/元数据/检查迁为顶栏唤起的 Dialog 与 Popover、实时预览并入主画布右侧仿真书页），使本文档定义的 `AgentPanel` 成为右侧唯一按需展开的独立悬浮侧栏；`--accent`、`--accent-fg-muted` 与 `--bubble-radius`（`14px`）随新色板同步更新。
- 对话输入卡底栏已由 [Agent approval modes, multi-model providers, preferences, reasoning & retry](../feature/2026-11-20-agent-modes-and-multimodel.md) 扩展为审批模式与供应商分组多模型双紧凑胶囊，并在消息流中增量加入了默认折叠的 `ReasoningBlock` 思考过程卡、自动应用/降级状态提示与末条助手重试操作。
