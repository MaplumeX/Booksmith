# ADR: Soft Craft Studio UI — borderless open canvas and decomposed tools

Status: implemented

## Problem

尽管 [the precision workbench UI decision](2026-11-20-precision-workbench-ui.md) 与 [the dedicated Agent sidebar decision](2026-11-20-agent-sidebar-chat-ui.md) 为浮层与对话补充了圆角、阴影和 Radix 无障碍原语，Booksmith 的整体视觉与空间骨架仍受制于 [the original workbench design system](../../archived/design/2026-11-19-workbench-design-system.md) 确立的「三栏 IDE 校样工作台」范式：

1. **右侧 5-Tab 检查器栏把异构工具硬塞进同一窄栏**：「预览 / 查找 / 元数据 / 目录 / 检查」具有截然不同的使用频率与空间诉求——目录与左侧文件树同样管理书籍结构却左右割裂；低频编辑的 9 项书籍元数据在 `400px` 窄栏里被拉成冗长单列表单；瞬时召唤的全书查找在窄栏内严重折行；95% 时间为空的结构检查常驻占据一个标签页。
2. **通顶通底的 `1px` 铁笼分割线与全屏 `28px` 底部状态栏强化了程序员 IDE 观感**：顶栏（`44px`）、左树（`240px`）、多标签代码栏、右栏（`440px`）与底栏（`28px` 工程状态栏，含 `UTF-8` 等技术字样）将屏幕切碎为紧绷的网格，连书库首页也套用了同一顶栏+底栏工作台外壳，缺乏图书创作与阅读软件的呼吸感。
3. **冷灰 + 钢墨蓝色板与紧凑控件尺度偏冷硬**：`#f2f4f7` 冷灰与 `#35618c` 钢墨蓝搭配 `26 / 30 / 36px` 紧凑控件高度，视觉气质更接近系统运维后台而非现代创意写作软件。

## Decision

完全替代并归档 [the original workbench design system](../../archived/design/2026-11-19-workbench-design-system.md)（同时完整承接其「纯 CSS 语义变量不引入 Tailwind」与「暗色模式下预览 iframe 保持书稿自有白底以模拟真实阅读器」两项底层约束），部分替代 [the precision workbench UI decision](2026-11-20-precision-workbench-ui.md) 与 [the dedicated Agent sidebar decision](2026-11-20-agent-sidebar-chat-ui.md) 中的旧色板、控件高度及常驻三栏 5-Tab 壳层条款（保留其 Radix 无障碍包装契约、`lucide-react` 图标体系与 IM 气泡对话流），将全站升级为 **Soft Craft Studio（微暖云灰画布 + 无框通透主编辑区 + 实体仿真书页 + Craft Indigo 灵动靛紫蓝）** 风格。

### Design Thesis

- **Visual**：**Soft Craft Studio（现代创意书坊）** —— 微暖云灰画布（`--surface-sunken: #f4f4f7`，暗色星夜蓝黑 `#12131a`）搭配纯净无框主工作面（`--surface: #ffffff` / `#1a1b24`）与灵动靛紫蓝强调色（`--accent: #4338ca` / `#9c97f4`）；严控卡片容器密度，**仅将「真实书封 / 书稿预览书页」与脱离文档流的浮层（Dialog / Popover / AI 助手侧卡）塑造为带漫射阴影的圆角实体**，彻底消除盒中套盒与横竖 `1px` 铁丝网。
- **Content**：
  - **书库与登录**：书库移除底部状态栏与顶栏卡片外框，重构为 `--surface-sunken` 画布上的藏书架画廊（`max-width: 1180px`），立体书封（带左侧书脊折痕高光与漫射阴影）直接立于画布之上、外围不套冗余白盒；登录页升级为 `max-width: 420px` 居中漫射扉页卡。
  - **编辑器空间骨架**：移除全屏底部 `28px` 状态栏与右侧 5-Tab 栏，重构为「无框透气顶栏 `52px` → 左侧无框结构栏 `256px`（融于 `--surface-sunken` 画布，顶部 `[ 文件 | 目录 ]` 二选一分段切换）+ 中央无框通透主编辑画布（消融代码行号竖线、顶栏底线与状态栏顶线；关闭预览时代码居中 `max-width: 900px`，开启「对照预览」时右侧在云灰桌面上呈现单页仿真书页 `.preview-pane`，无冗余预览顶栏）+ 按需滑出的右侧独立 AI 助手悬浮白卡 `400–560px`」。
- **Interaction**：四大工具去侧边栏化——目录并入左结构栏 `[ 文件 | 目录 ]` 实时切换；全书查找升级为顶栏幽灵按钮或 `⌘⇧F` 唤起的居中 Spotlight 弹窗（`max-width: 640px`，点命中项跳行并由 `Dialog` 的 `onCloseAutoFocus` 阻止焦点回抢，使编辑器保持聚焦）；元数据升级为顶栏「元数据」按钮唤起的居中双栏书籍信息弹窗（`max-width: 680px`，底部 `META` 键值表采用去卡片化的扁平四列细线行）；结构检查升级为顶栏动态健康度按钮 + `380px` 下拉诊断浮卡（Radix `Popover`）。所有浮层与过渡仅动 `transform / opacity`（`140–180ms`，`prefers-reduced-motion` 下仅保留透明度）。

### Color Ramps & Contrast Verification

通过 `generate_ramp.py` 推导 9 阶色板并经 `check_contrast.py` 与 `tokens.test.ts` 实测校验（浅/暗全部 25 组文本/背景配对均 `>= 5.29:1`，禁用纯黑 `#000`）：

- **中性云灰阶（`neutral-100..900` + `950`）**：`#f4f4f6 · #d1d1da · #afb0bd · #8e8e9f · #6e6e80 · #5a5a6b · #464655 · #33333e · #202028 · #12131a`
- **灵动靛紫阶（`primary-100..900`）**：`#edecfe · #c4c1f9 · #9c97f4 · #756eed · #4f46e5 · #4338ca · #3730a3 · #1e1b4b · #090641`

| 语义 Token | 浅色 (`:root`) | 暗色 (`[data-theme='dark']`) | 实测对比度 / 用途 |
|---|---|---|---|
| `--surface-sunken` | `#f4f4f7` | `#12131a` | 全屏底层微暖云灰 / 星夜画布、左侧无框结构栏与右侧书页预览托底桌面 |
| `--surface` | `#ffffff` | `#1a1b24` | 中央无框通透主编辑画布、激活分段滑块与书封表面 |
| `--surface-raised` | `#f4f4f6` | `#222430` | 分段控件底槽、活动章节轻标签、代码块与助手气泡表面 |
| `--surface-elevated` | `#ffffff` | `#282a38` | Dialog 弹窗、Popover 诊断卡、DropdownMenu 与 ContextMenu |
| `--hover-bg` | `#e8e8f0` | `#323546` | 悬停反馈底；配 `--text-secondary` = `7.60:1`（浅）｜`5.99:1`（暗） |
| `--text` | `#202028` | `#ececf2` | 主文字；配 `--surface` / `--surface-raised` / `--surface-elevated` = `16.17` · `14.72` · `16.17:1`（浅）｜`14.56` · `13.09` · `12.07:1`（暗） |
| `--text-secondary` | `#464655` | `#b4b5c7` | 次级文字；配 `--surface` / `--surface-elevated` = `9.26:1`（浅）｜`8.46` · `7.02:1`（暗） |
| `--text-muted` | `#5a5a6b` | `#9e9fb3` | 弱化文字；配三档表面 = `6.75` · `6.15` · `6.75:1`（浅）｜`6.58` · `5.92` · `5.45:1`（暗） |
| `--border` / `--border-strong` | `#e2e2ea` / `#afb0bd` | `#2c2e3d` / `#464655` | 浮层描边、表单输入框边界与焦点环辅助边界 |
| `--accent` / `--accent-hover` | `#4338ca` / `#3730a3` | `#9c97f4` / `#b0acf7` | 主操作、激活态与用户气泡；配 `--accent-fg`（`#ffffff` / `#090641`）= `7.90:1`（浅）｜`7.31:1`（暗） |
| `--accent-subtle` / `--accent-fg-muted` | `#edecfe` / `#edecfe` | `#1e1b4b` / `#1e1b4b` | 选中柔和浅底；实心强调气泡内次级文字配 `--accent` = `6.79:1`（浅）｜`6.20:1`（暗） |
| `--selection-bg` / `--selection-fg` | `#c4c1f9` / `#090641` | `#3730a3` / `#ececf2` | 编辑器文本选区 = `11.08:1`（浅）｜`8.44:1`（暗） |
| `--status-ok-{bg,fg}` | `#e6f2e8` / `#2c5b39` | `#16301f` / `#a8cdb4` | 检查通过徽标 = `6.85:1`（浅）｜`8.16:1`（暗） |
| `--status-warn-{bg,fg}` | `#fdf1dc` / `#8a5a12` | `#3a2c14` / `#dcb877` | 检查提醒徽标 = `5.29:1`（浅）｜`7.20:1`（暗） |
| `--status-error-{bg,fg}` | `#fbeae6` / `#8f2f21` | `#3a1c17` / `#e3a99b` | 错误状态 = `6.94:1`（浅）｜`7.67:1`（暗）；配 `--surface-elevated` = `8.09:1`｜`7.04:1` |
| `--danger` / `--danger-hover` / `--danger-fg` | `#b43b2a` / `#962f21` / `#ffffff` | `#e07a6b` / `#ea9083` / `#1a1b24` | 破坏性确认按钮 = `5.83:1` / `7.71:1`（浅）｜`5.84:1` / `7.19:1`（暗） |
| `--cm-{tag,attr,string,comment,keyword,number}` | `#3730a3` / `#8a5a12` / `#2c5b39` / `#5a5a6b` / `#1c14a5` / `#a0562a` | `#a5b4fc` / `#dcb877` / `#a8cdb4` / `#9e9fb3` / `#c4c1f9` / `#e0a97c` | 代码语法高亮在 `--surface` 上全部 `5.44:1–12.41:1` |

### Scales & Component Contracts

- **尺度**：圆角 `--radius-sm: 6px`、`--radius-md: 10px`、`--radius-lg: 16px`、`--bubble-radius: 14px`；控件高度 `--control-sm: 30px`、`--control-md: 36px`、`--control-lg: 42px`；顶栏 `--topbar-h: 52px`、左结构栏 `--tree-w: 256px`。
- **左结构栏（`FileTree` + `TocPanel`）**：无框融入左侧 `--surface-sunken` 画布（`<1024px` 下转为带阴影的悬浮抽屉），顶部 `role="tablist"` 提供 `[ 文件 | 目录 ]`（`role="tab"`）分段切换；切至「目录」时展示层级大纲，支持原地改名、上下移、缩进/取消缩进、新增与删除条目。
- **中央无框通透画布与仿真书页（`TabBar` + `CodePane`/`WysiwygPane` + `PreviewPane` + `StatusBar`）**：
  - 主编辑区无外层卡片框与四周描边，顶部内嵌无底线 `TabBar`（左侧轻章节标签，右侧 `[ 对照预览 ]` 开关与 `[ 代码 | 可视化 ]` 切换），底部内嵌无顶线 `.statusbar` 页脚（显示当前路径、字数与未保存文件计数，去除 `UTF-8`）；
  - `CodePane` 移除行号栏右侧分割竖线与灰色底条，关闭对照预览时代码区自动居中限宽 `max-width: 900px`；
  - `PreviewPane` 移除冗余预览标题栏，在右侧 `--surface-sunken` 桌面上仅呈现单张带圆角与阴影的仿真书页（`.preview-pane`），且在切换至可视化模式时使用 `hidden` 保持 DOM 挂载以避免 iframe 重载。
- **三大去侧边栏化工具**：
  - **Spotlight 全书查找弹窗（`SearchPanel` in `Dialog`）**：由顶栏「查找」按钮或 `⌘⇧F` / `Ctrl+Shift+F` 唤起，居中 `max-width: 640px`（`ariaLabel="查找与替换"`）；点击 `.search-hit` 跳至目标文件行号并自动关闭弹窗，通过 `onCloseAutoFocus={(e) => e.preventDefault()}` 保持编辑器光标聚焦。
  - **书籍信息双栏弹窗（`MetadataPanel` in `Dialog`）**：由顶栏「元数据」按钮唤起，居中 `max-width: 680px`；上半部双栏网格排布 9 项核心出版字段（`<680px` 单列），下半部以扁平四列细线行展示 OPF `<meta>` 键值列表。
  - **结构检查诊断浮卡（`CheckPanel` in Radix `Popover`）**：由顶栏「检查」动态健康度按钮触发（实时显示错误/提醒数徽标），下拉弹出 `width: 380px` 漫射诊断卡，条目采用无框细线列表，点击问题项跳行并关闭浮卡。

## Alternatives considered

- **把左结构岛、主代码区、右预览区、顶栏胶囊、书库顶栏与封面外框全部做成独立带描边阴影的白卡（Multi-Card Box Containers）**：首轮实施后在真实浏览器目视巡检中暴露出「卡片容器过多、盒中套盒、主内容区像把旧 IDE 网格关进圆角白盒」的视觉疲劳；随即按用户反馈推进去卡片化（De-carding）与无框通透画布（Direction B），仅保留真实书页/书封与浮层弹窗的实体卡片层级。
- **仅更换配色与圆角，保留常驻三栏 + 右侧 5-Tab + 底部 `28px` 状态栏骨架（Reskin Only）**：换色不换骨，通栏分割线、底部状态栏与右侧 5-Tab 属性检查器组合在一起仍呈典型的 IDE 工作台观感。
- **悬浮双页对开工作坊并把左侧文件树收为顶栏下拉菜单（Floating Spread without Left Column）**：虽然进一步弱化了侧栏，但 EPUB 编辑常需在数十个章节与 CSS/图片资源间频繁切换，隐藏左栏会增加每次切换的点击成本。
- **将目录 / 元数据 / 查找 / 检查合并进同一个居中「四合一工具箱」大弹窗**：虽能移除右侧栏，但将目录关进模态弹窗后无法边看大纲边切换章节，且将高频查找与低频元数据绑在同一容器内不够轻巧。
- **连同主画布顶部的已打开章节标签条一并删除，仅显示单章标题**：界面更极简，但在同时修改章节 `.xhtml` 与 `stylesheet.css` 时失去了快速来回切换的入口。
- **暖调纸本印书馆（亚麻暖纸 + 赤陶朱砂 + 衬线标题）或极简黑白阅读器（单色墨黑 + 鼠尾草绿）或电光钴蓝体系**：用户明确偏好更具现代消费级创意软件活力感的 Soft Craft Studio（微暖云灰画布 + Craft Indigo 灵动靛紫蓝）。

## Consequences

**验收结果（2026-11-20）**

- 全仓类型检查、构建与单元测试全部通过：`pnpm -r typecheck`、`pnpm -r build`（`core` / `server` / `web` 2308 modules）与 `pnpm test`（22 个测试文件、211 条断言，含 `tokens.test.ts` 53 条浅/暗 `>= 4.5:1` 对比度与圆角刻度守卫）全部通过。
- 全量 Playwright 端到端测试 69/69 通过（含更新后的 `panels.spec.ts`、`meta.spec.ts`、`search.spec.ts`、`replace.spec.ts`、`check.spec.ts`、`wysiwyg.spec.ts` 与 `agent.spec.ts`）；`node e2e/audit-shots.mjs` 在 `1440px`、`400px` 与暗色模式下输出 `audit: clean`（零横向溢出、零断图、零运行时错误）。
- 用户已在在线预览环境中完成「去卡片套盒 + 无框通透主画布」的目视与交互验收。
- [The original workbench design system](../../archived/design/2026-11-19-workbench-design-system.md) 已随本次交付正式迁入 `archived/design/`。

**代价与已知限制**

- **实时预览 iframe 常驻挂载**：为保证在代码模式与可视化（WYSIWYG）模式间来回切换、或开关「对照预览」时不触发 `.preview-frame` 重载闪烁，`PreviewPane` 在打开可预览章节期间通过 `hidden` 属性保持挂载，内存占用与旧版常驻右栏预览持平。
- **窄屏（`<= 560px`）顶栏文字折叠**：为在 `400px` 视口下同时容纳返回书库、文件抽屉、元数据、版本历史、查找、检查、助手、加资源与保存 9 项入口且保持零横向溢出，`<= 560px` 下次级动作仅展示图标并通过 `aria-label` 暴露无障碍名称。
