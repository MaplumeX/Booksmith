# Booksmith DESIGN

## 1. Product & Brand Context

**使用者**：创作与校对 EPUB 的作者或编辑者，一人或小团队自托管。界面以书稿纸面为视觉重心，兼顾可视化校对与源码/实时书页双卡对照。

**调性**：**Soft Craft Studio（现代创意书坊）**。微暖云灰画布（`--surface-sunken: #f4f4f7`，暗色星夜 `#12131a`）搭配无框通透主编辑面（`--surface: #ffffff` / `#1a1b24`）与灵动靛紫蓝（`--accent: #4338ca` / `#9c97f4`）高意图交互强调色；严控卡片容器数量，仅让「真实书封 / 书稿预览书页」与脱离文档流的浮层具备圆角漫射阴影，彻底消除盒中套盒、通栏 `1px` 铁笼分割线与底部工程状态栏。

**文案**：直接、说清下一步。按钮用动词（「保存」「导入」「重新加载」），空态给出行动而不是「暂无数据」，错误说清"发生了什么 + 现在能做什么"。

**不要做**：通顶通底的 IDE 网格铁笼、盒中套盒的多重卡片包裹、全屏底部工程状态栏、右侧多标签属性检查器、无源渐变、卡片粗侧边色条、`transition: all`、纯黑 `#000`、红绿单独表意、`Lorem ipsum`。

## 2. Tokens & Conventions

全部 token 在 `apps/web/src/styles/tokens.css`，组件只消费语义别名，禁止写死颜色。
色板与实测对比度见 `.agents/ADR/implemented/design/2026-11-20-soft-craft-studio-ui.md`、
`.agents/ADR/implemented/design/2026-11-20-precision-workbench-ui.md`
与 `.agents/ADR/implemented/design/2026-11-20-agent-sidebar-chat-ui.md`。

- **主题**：`:root` 浅色，`[data-theme="dark"]` 覆盖语义别名。暗色浮层使用 `--surface-elevated`（`#282a38`）+ 顶部 `1px` 内高光 + `--border-strong`。
- **文字三级**：`--text`（`#202028` / `#ececf2`）、`--text-secondary`（`#464655` / `#b4b5c7`）、`--text-muted`（`#5a5a6b` / `#9e9fb3`，在三档表面均 `>= 5.45:1`）。`--neutral-500` 只用于图标与禁用态，永不承载正文。
- **强调与危险**：`--accent`（`#4338ca` / `#9c97f4`）用于主按钮、激活胶囊与用户对话气泡，`--accent-fg-muted`（`#edecfe` / `#1e1b4b`）用于实心强调气泡内次级上下文标签，`--accent-subtle` 用于柔和选中底；`--danger` / `--danger-fg` / `--danger-subtle` 用于破坏性操作。
- **状态**：`--status-{ok,error,warn}-{bg,fg}` 成对使用，浅底深字；必须配图标或文字，不单靠颜色。
- **字号**：`12 / 13 / 14 / 16 / 20`；UI 正文 `14px`，代码 `13px` 等宽；行高 UI `1.5`、中文正文 `1.6–1.75`。
- **间距与控件**：`--space-1..6` = `4 / 8 / 12 / 16 / 24`；控件高 `30 / 36 / 42`。
- **圆角与层次**：`--radius-sm: 6px` / `--radius-md: 10px` / `--radius-lg: 16px` / `--bubble-radius: 14px`；`--shadow-sm/md/lg` 用于悬浮工作卡、书卡、下拉菜单与弹窗，`--shadow-inset` 用于输入框内凹。
- **焦点**：`:focus-visible` 2px `--focus-ring` + `offset 2px`，从不全局 `outline: none`。
- **布局与四大工具去侧边栏化**：
  - **书库画廊**：无底部状态栏、无顶栏卡片套盒与书卡外层套盒，立体书封直接呈现在 `--surface-sunken` 画廊画布上（`max-width: 1180px`）；登录扉页卡 `max-width: 420px`。
  - **编辑器画布**：无框透气顶栏 `52px`；左侧无框结构栏 `256px`（顶部 `[ 文件 | 目录 ]` 二选一分段切换）；中央无框通透主编辑画布（消融代码行号竖线、顶栏底线与状态栏顶线；关闭预览时代码居中 `max-width: 900px`，开启「对照预览」时右侧在云灰桌面上仅呈现单张仿真书页 `.preview-pane`）；右侧仅在开启「助手」时滑出独立悬浮白卡（`400–560px`）。
  - **按需浮层工具**：「元数据」双栏书籍信息弹窗 `max-width: 680px`（底部 `META` 采用去卡片化四列细线行）；「查找」Spotlight 居中弹窗 `max-width: 640px`（`⌘⇧F`）；「检查」顶栏动态健康度按钮 + `width: 380px` 下拉诊断 Popover；普通确认弹窗 `max-width: 440px`；空状态 `max-width: 40ch`。
- **动效**：只动 `transform` / `opacity`，`120–160ms`；`prefers-reduced-motion` 下仅保留透明度。

## 3. Component Index & State Matrix

| 组件 | 路径 | 状态 |
|---|---|---|
| `Button` | `src/ui/Button.tsx` | primary / secondary / ghost / danger / sm·md·lg / hover / focus-visible / disabled |
| `ContextMenu` | `src/ui/ContextMenu.tsx` | Radix ContextMenu；图标 + 分组 + danger / disabled / edge（视口回拉）/ 键盘导航 |
| `Dialog` | `src/ui/Dialog.tsx` | Radix Dialog；default / wide / 自定义 `onCloseAutoFocus` / 右上角关闭 / 右下角动作 / Escape 与遮罩关闭 |
| `FileTypeIcon` | `src/ui/FileTypeIcon.tsx` | 文本 / 样式代码 / 图片 / 容器四类统一线宽图标 |
| `FileTree` | `src/ui/FileTree.tsx` | 左悬浮结构岛「文件」视图；default / empty（无图片组）/ loading / error / edge（长名截断）/ 接入 `ContextMenu` |
| `TocPanel` | `src/ui/TocPanel.tsx` | 左悬浮结构岛「目录」视图；default（单击跳转与高亮、折叠/按级展开、过滤、拖拽、多选批量栏、右键与 `···` 菜单、50 步撤销重做）/ empty（缺失目录初始化、空目录、过滤无命中）/ error（断链徽标点击直达修复、仅看断链）/ edge（177+ 项滚动、深层缩进钳制、长标题截断） |
| `TocLinkDialog` | `src/ui/TocLinkDialog.tsx` | `480px` 居中目录链接弹窗；default（目标文件 + 章内 `#id` 自动扫描下拉 + 读取标题）/ error（缺失文件与断链实时警示）/ edge（自定义 `#fragment`、手贴完整 `path#id`） |
| `TocGenerateDialog` | `src/ui/TocGenerateDialog.tsx` | `680px` 居中正文标题生成目录弹窗；default（`H1–H6` 独立勾选、补全/重建切换、自动补 `id` 章节计数、可交互预览树）/ empty（无匹配标题引导）/ edge（含 MathML 原书非破坏补全、`+id` 与 `已有` 状态标注、窄屏栈叠） |
| `TabBar` | `src/ui/TabBar.tsx` | 中央文档白卡顶栏；default / active（胶囊高亮）/ dirty / overflow（滚轮与自动滚入可视）/ 右侧「对照预览」开关 +「代码 \| 可视化」模式切换 |
| `CodePane` | `src/ui/CodePane.tsx` | default / loading / error（语法错误）/ edge（174KB 单章） |
| `WysiwygPane` | `src/ui/WysiwygPane.tsx` | default（760px 纸面 + 格式栏，跟随全局主题）/ empty（空章可聚焦）/ loading（骨架）/ error（非良构 XML 拦截切回代码）/ edge（`<math>` 保护岛、`<a>` 锚点与 `<img>` 浮条） |
| `PreviewPane` | `src/ui/PreviewPane.tsx` | 代码模式右侧并排实时书页白卡（跟随全局主题）；default / empty / loading（骨架）/ error（带图标警示）/ edge（MathML、缺图） |
| `MetadataPanel` | `src/ui/MetadataPanel.tsx` | 顶栏「元数据」触发的 `680px` 居中双栏书籍信息弹窗；default / dirty / error / meta 卡片行编辑 / edge（`<640px` 单列退化） |
| `SearchPanel` | `src/ui/SearchPanel.tsx` | 顶栏「查找」或 `⌘⇧F` 触发的 `640px` 居中 Spotlight 弹窗；default（点击命中项跳行并关闭弹窗）/ empty / loading / 全书替换确认与撤销 |
| `CheckPanel` | `src/ui/CheckPanel.tsx` | 顶栏「检查」动态健康度胶囊触发的 `380px` Radix Popover 诊断浮卡；empty（通过绿标）/ 错误与提醒分层卡片 / 点击跳行并收起浮卡 |
| `AgentPanel` | `src/ui/AgentPanel.tsx` | 右侧独立悬浮对话白卡；default（`38px` 单行顶栏 + Radix Popover 历史会话 + IM 左右气泡与 Markdown + 中文工具步骤条 + 悬浮输入卡）/ empty / loading / error / edge（`<1024px` 互斥覆盖抽屉） |
| `AgentMarkdown` | `src/ui/AgentMarkdown.tsx` | default（零依赖安全 React Markdown）/ empty / loading / error / edge（宽表与长代码独立横向滚动） |
| `AgentProposalCard` | `src/ui/AgentProposalCard.tsx` | default（气泡外通栏轻量卡 + `+N/-M` 统计 + 折叠字符级 Diff）/ applied / dismissed / error / edge |
| `AgentSettingsDialog` | `src/ui/AgentSettingsDialog.tsx` | 导出嵌入式 `AgentSettingsPanel`（集成于 `SettingsDialog` 的「AI 助手」分页）/ 多预设列表 / OpenAI·Anthropic 分段协议控件 / API Key 显隐切换 / 测试连接反馈 |
| `SettingsDialog` | `src/ui/SettingsDialog.tsx` | Radix Dialog (`760px`) / 「通用 \| AI 助手」分页 / 外观主题（跟随系统·浅色·深色，全局同步界面、代码与预览）/ 编辑器字号·自动换行·默认模式·默认对照预览 / 恢复默认 / 内嵌 AI 助手模型预设管理 |
| `MediaPane` | `src/ui/MediaPane.tsx` | default（带外框预览）/ 非图片（图标说明）/ 替换确认（Radix Dialog）/ 删除入口 |
| `SearchBar` | `src/ui/SearchBar.tsx` | 圆角胶囊搜索框；default / focus-within / Lucide 搜索图标 |
| `VersionHistory` | `src/ui/VersionHistory.tsx` | Radix Dialog (`wide`) / 时间轴 + diff / empty / loading / error / 置顶（Pin 图标）/ 恢复确认 |
| `StatusBar` | `src/ui/StatusBar.tsx` | 内嵌于中央文档白卡底部；路径图标 / 字数（等宽数字）/ 未修改或 N 个文件未保存 |
| `BookCard` | `src/ui/BookCard.tsx` | 藏书架画廊漫射白卡（`--radius-lg` + 书脊折痕高光）/ hover 抬升与下载·删除浮标显现 / 键盘 focus-within 可见 / 接入 `ContextMenu` 与删除确认弹窗 |
| `EmptyState` | `src/ui/EmptyState.tsx` | 漫射圆角白卡（`40ch`）+ 强调色图标徽章 + 标题 + 说明 + 主操作 |
| `Login` | `src/routes/Login.tsx` | default（`420px` 居中漫射扉页卡）/ error（带图标横幅）/ pending |

状态矩阵的完整定义（每个组件的五态行为）见设计 ADR。新增组件时必须在此表登记路径与已覆盖状态。
