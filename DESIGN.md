# Booksmith DESIGN

## 1. Product & Brand Context

**使用者**：长时间校对 epub 的编辑者，一人或小团队自托管。屏幕切成结构、文本、渲染三块，
眼睛在等宽代码与纸面预览之间反复切换。

**调性**：精密桌面校对工作台。三栏工作区保留冷灰纸面与 `1px` 分割线控制噪声，脱离文档流的
浮层（右键菜单 / 弹窗）与可点击封面采用 `--surface-elevated`、三档圆角（`4 / 6 / 10px`）、
双层阴影（暗色叠 `1px` 顶部内高光）及统一的 `lucide-react` 1.5–1.75px 线性图标。

**文案**：直接、说清下一步。按钮用动词（「保存」「导入」「重新加载」），空态给出行动而不是
「暂无数据」，错误说清"发生了什么 + 现在能做什么"。

**不要做**：无源渐变、卡片粗侧边色条、`transition: all`、纯黑 `#000`、红绿单独表意、`Lorem ipsum`。

## 2. Tokens & Conventions

全部 token 在 `apps/web/src/styles/tokens.css`，组件只消费语义别名，禁止写死颜色。
色板与实测对比度见 `.agents/ADR/implemented/design/2026-11-19-workbench-design-system.md`、
`.agents/ADR/implemented/design/2026-11-20-precision-workbench-ui.md`
与 `.agents/ADR/implemented/design/2026-11-20-agent-sidebar-chat-ui.md`。

- **主题**：`:root` 浅色，`[data-theme="dark"]` 覆盖语义别名。暗色浮层使用 `--surface-elevated`
  （`#2b3544`）+ 顶部 `1px` 内高光 + `--border-strong`。
- **文字三级**：`--text` / `--text-secondary` / `--text-muted`（暗色提亮至 `#95a3b6`，在三档表面均
  `>= 4.5:1`）。`--neutral-500` 只用于图标与禁用态，永不承载正文。
- **强调与危险**：`--accent` 用于主按钮、选中与用户对话气泡，`--accent-fg-muted` 用于实心强调气泡内次级上下文标签，`--accent-subtle` 用于选中背景；`--danger` /
  `--danger-fg` / `--danger-subtle` 用于破坏性操作（删除确认、右键删除项）。
- **状态**：`--status-{ok,error,warn}-{bg,fg}` 成对使用，浅底深字；必须配图标或文字，不单靠颜色。
- **字号**：`12 / 13 / 14 / 16`；UI 13，代码 13 等宽；行高 UI `1.45`、中文正文 `1.6–1.75`。
- **间距**：`--space-1..6` = `4 / 8 / 12 / 16 / 24`；控件高 `26 / 30 / 36`。
- **圆角与层次**：`--radius-sm: 4px` / `--radius-md: 6px` / `--radius-lg: 10px` / `--bubble-radius: 12px`；`--shadow-sm/md/lg`
  仅用于书卡/按钮微抬升、右键菜单、输入卡与弹窗，`--shadow-inset` 用于输入框内凹。
- **焦点**：`:focus-visible` 2px `--focus-ring` + `offset 2px`，从不全局 `outline: none`。
- **布局**：`100dvh` 三段式；顶栏 `44`、TabBar / 侧栏 Tab / 独立助手顶栏 `38`、状态栏 `28`、文件树 `240`、
  右侧栏 `400–560`（5-Tab「预览/结构」栏与顶栏一键开关的独立「助手」侧栏全屏宽互斥）；`<1024px` 右侧栏与文件树收成抽屉。登录卡片 `max-width: 380px`、普通弹窗 `440px`、
  书库网格 `1120px`、空状态 `38ch`。
- **动效**：只动 `transform` / `opacity`，`120–160ms`；`prefers-reduced-motion` 下仅保留透明度。

## 3. Component Index & State Matrix

| 组件 | 路径 | 状态 |
|---|---|---|
| `Button` | `src/ui/Button.tsx` | primary / secondary / ghost / danger / sm·md·lg / hover / focus-visible / disabled |
| `ContextMenu` | `src/ui/ContextMenu.tsx` | Radix ContextMenu；图标 + 分组 + danger / disabled / edge（视口回拉）/ 键盘导航 |
| `Dialog` | `src/ui/Dialog.tsx` | Radix Dialog；default / wide / 右上角关闭 / 右下角动作 / Escape 与遮罩关闭 |
| `FileTypeIcon` | `src/ui/FileTypeIcon.tsx` | 文本 / 样式代码 / 图片 / 容器四类统一线宽图标 |
| `FileTree` | `src/ui/FileTree.tsx` | default / empty（无图片组）/ loading / error / edge（长名截断）/ 接入 `ContextMenu` |
| `TabBar` | `src/ui/TabBar.tsx` | default / active（胶囊高亮）/ dirty / overflow（隐藏滚动条 + 滚轮与自动滚入可视）/ 右侧「代码 \| 可视化」模式切换（非页面禁用） |
| `CodePane` | `src/ui/CodePane.tsx` | default / loading / error（语法错误）/ edge（174KB 单章） |
| `WysiwygPane` | `src/ui/WysiwygPane.tsx` | default（760px 纸面 + 格式栏）/ empty（空章可聚焦）/ loading（骨架）/ error（非良构 XML 拦截切回代码）/ edge（`<math>` 保护岛、`<a>` 锚点与 `<img>` 浮条、纸面深浅切换） |
| `PreviewPane` | `src/ui/PreviewPane.tsx` | default / empty / loading（骨架）/ error（带图标警示）/ edge（MathML、缺图） |
| `MetadataPanel` | `src/ui/MetadataPanel.tsx` | default / dirty / error（字段非法）/ meta 卡片行编辑 / edge（同一 property+refines 重复行） |
| `TocPanel` | `src/ui/TocPanel.tsx` | default / empty / error（锚点失效）/ 新增表单 / 缩进禁用 / Lucide 行内操作 |
| `CheckPanel` | `src/ui/CheckPanel.tsx` | empty（全部通过图标提示）/ 错误与提醒分层卡片（带图标）/ 点击跳行 |
| `AgentPanel` | `src/ui/AgentPanel.tsx` | default（独立 `38px` 单行顶栏 + Radix Popover 历史会话切换/重命名/删除 + IM 左右气泡与 Markdown 渲染 + 中文工具步骤条 + 底部一体化悬浮输入卡与 Radix 模型菜单）/ empty（未配置模型引导 / 居中欢迎徽章与快捷任务卡）/ loading（气泡骨架与流式生成 + 停止）/ error（版本冲突、未配密钥、上游报错带恢复动作）/ edge（上下文移除与重挂、超长标题截断、`<1024px` 互斥抽屉） |
| `AgentMarkdown` | `src/ui/AgentMarkdown.tsx` | default（零依赖安全 React Markdown：标题/列表/行内代码/可复制围栏代码块/引用/横向可滚表格/安全链接）/ empty（空串不渲染）/ loading（流式未闭合代码块）/ error（非法 URL 协议降级纯文本）/ edge（宽表与长代码独立横向滚动） |
| `AgentProposalCard` | `src/ui/AgentProposalCard.tsx` | default（气泡外通栏轻量卡 + 每文件 `+N/-M` 统计 + 纯文本按文件勾选或结构变更原子应用 + 折叠字符级 Diff）/ applied（单行状态 + 一键撤销本次应用）/ dismissed（低对比单行折叠）/ error（结构预检阻断并列诊断）/ edge（删除影响引用提示、大 Diff 折叠展开） |
| `AgentSettingsDialog` | `src/ui/AgentSettingsDialog.tsx` | Radix Dialog (`760px` 宽双栏) / 多预设列表（协议简标 + 默认标记）/ OpenAI·Anthropic 分段协议控件 / OpenAI·Anthropic·DeepSeek·Ollama 模板高亮 / API Key 显隐切换 / 测试连接反馈 / empty / loading / error（缺 `AGENT_SECRET_KEY` 警告、测试失败）/ edge（留空保留已存密钥、删除二次确认、`<720px` 单栏） |
| `MediaPane` | `src/ui/MediaPane.tsx` | default（带外框预览）/ 非图片（图标说明）/ 替换确认（Radix Dialog）/ 删除入口 |
| `SearchPanel` | `src/ui/SearchPanel.tsx` | default / empty / loading / 全书替换确认与撤销 |
| `SearchBar` | `src/ui/SearchBar.tsx` | default / focus-within / Lucide 搜索图标 + 内凹边界 |
| `VersionHistory` | `src/ui/VersionHistory.tsx` | Radix Dialog (`wide`) / 时间轴 + diff / empty / loading / error / 置顶（Pin 图标）/ 恢复确认 |
| `StatusBar` | `src/ui/StatusBar.tsx` | 路径图标 / 字数与编码（等宽数字）/ 已保存或 N 个文件未保存 |
| `BookCard` | `src/ui/BookCard.tsx` | default（`--shadow-sm`）/ hover 抬升与下载显现 / 键盘 focus-within 可见 |
| `EmptyState` | `src/ui/EmptyState.tsx` | 图标卡片徽章 + 标题 + 说明（38ch）+ 主操作 |
| `Login` | `src/routes/Login.tsx` | default（380px 抬升卡）/ error（带图标横幅）/ pending |

状态矩阵的完整定义（每个组件的五态行为）见设计 ADR。新增组件时必须在此表登记路径与已覆盖状态。
