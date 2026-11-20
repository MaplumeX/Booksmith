# ADR: Precision workbench UI — elevation, icons, and Radix overlays

Status: implemented

## Problem

[The original workbench design system](../../archived/design/2026-11-19-workbench-design-system.md) 建立了一套低噪声的冷灰印刷校样台基准，禁止卡片阴影、只保留单一 `4px` 圆角且未引入图标与浮层组件库。在实际界面中，这一极简约束放大了组件细节的粗糙感：

- **浮层与工作区混为一体，暗色模式失效**：`FileTree` 右键菜单（`.context-menu`）使用了硬编码浅色阴影且底色仍为 `--surface`，暗色模式下边界模糊；`.dialog` 仅靠 `1px --border` 区分，遮罩使用硬编码 `rgb(...)`。
- **交互原语缺失导致重复与行为漂移**：右键菜单内嵌在 `FileTree.tsx` 中，缺少键盘方向键导航与通用容器；`.dialog-backdrop` / `.dialog` 在 `Editor.tsx`、`Library.tsx`、`MediaPane.tsx` 与 `VersionHistory.tsx` 四处重复手写，缺少右上角关闭按钮、统一 `Escape`/遮罩关闭与右下角动作对齐。
- **危险操作与状态反馈缺少视觉分级**：删除确认弹窗主按钮沿用强调色 `--accent`，右键菜单「删除」与常规操作同色同重，暗色模式下 `--text-muted`（`#8896aa`）在抬升表面上对比度跌破 `4.5:1`。
- **图标与表单控件手感单薄**：全站仅 `SearchBar` 与 `EmptyState` 使用内联 SVG，其余位置混用纯字符（`×`、`◇/◆`、`←`）或完全无图标；文件树、TabBar、右侧面板、书库封面卡与登录页缺少细腻的表面阶梯与输入内凹层次。

## Decision

部分替代并扩展 [the original workbench design system](../../archived/design/2026-11-19-workbench-design-system.md) 中的「无阴影 / 单一 4px 圆角 / 零外部 UI 原语」条款，保留其「冷灰 + 墨蓝」护眼色板、三栏 `100dvh` 工作区尺寸与低噪声排版骨架，将整体界面升级为「精密桌面校对工作台」。

### Design Thesis

- **Visual**：精密桌面校对工作台 —— 固定三栏延续 `1px` 冷灰分割线避免视野疲劳；悬浮层（右键菜单、弹窗）与可点击卡片采用 `--surface-elevated`、三档圆角（`4 / 6 / 10px`）、双层阴影（暗色叠加 `1px` 顶部内高光描边）以及 `lucide-react`（`^1.75.0`）统一 `1.5–1.75px` 线宽线性图标。
- **Content**：保持「顶栏 `44px` → 三栏工作区（文件树 `240px` / 全宽代码区 / `400–560px` 侧边栏）→ `28px` 状态栏」；非全宽场景严格限宽（登录卡片 `max-width: 380px`、普通弹窗 `max-width: 440px`、书库网格 `max-width: 1120px`、空状态 `max-width: 38ch`）。
- **Interaction**：浮层具备 `120–160ms` 基于 `transform / opacity` 的入场动效（`prefers-reduced-motion` 下仅保留透明度）；右键菜单与弹窗由 `radix-ui`（`^1.8.1`）提供完整键盘导航（`↑/↓/Home/End/Escape`）、焦点陷阱与视口碰撞回拉。

### Token Expansions & Contrast Verification

全部新增及微调语义 token 均在 `apps/web/src/styles/tokens.css` 定义并受 `tokens.test.ts` 守卫（已通过 `.agents/skills/mm-ui/scripts/check_contrast.py` 与 `vitest` 验算，全部文本/背景配对 ≥4.5:1 且禁用 `#000`）：

| Token | 浅色 (`:root`) | 暗色 (`[data-theme='dark']`) | 实测对比度 / 用途 |
|---|---|---|---|
| `--surface-elevated` | `#ffffff` | `#2b3544` | 浮层与独立卡片表面；暗色配 `--text` (`#e9edf2`) = `10.53:1`，配 `--text-secondary` (`#aab5c6`) = `5.98:1` |
| `--text-muted` | `#546175` | `#95a3b6` | 暗色由 `#8896aa` 提亮；配 `--surface-elevated` / `--surface-raised` / `--surface` = `4.83` / `5.43` / `6.25:1`（浅色 `6.28` / `5.70:1`） |
| `--hover-bg` | `#e3e8ef` | `#354152` | 配 `--text-secondary`：浅 `7.07:1` ｜ 暗 `4.99:1`；暗色配 `--text` = `8.80:1` |
| `--danger` / `--danger-fg` | `#b43b2a` / `#ffffff` | `#e07a6b` / `#1b222c` | `5.83:1` ｜ `5.46:1`；hover `#962f21` (`7.71:1`) ｜ `#ea9083` (`6.72:1`) |
| `--danger-subtle` | `#fbeae6` | `#3a1c17` | 配 `--status-error-fg` (`#8f2f21` / `#e3a99b`) = `6.94:1` ｜ `7.67:1`；错误文字在 `--surface-elevated` 上 = `8.09:1` ｜ `6.14:1` |
| `--radius-{sm,md,lg}` | `4px / 6px / 10px` | 同左 | 保留 `--radius: 4px` 别名；sm 用于树项/菜单项/Tab，md 用于按钮/输入框/右键菜单，lg 用于弹窗/登录卡/书卡 |
| `--shadow-{sm,md,lg}` | 冷灰两段式阴影 | 深色双层阴影 + `inset 0 1px 0 rgb(255 255 255 / 6%)` | 仅用于 `BookCard` / 按钮 (`sm`)、`ContextMenu` (`md`)、`Dialog` / `Login` (`lg`) |
| `--shadow-inset` | `inset 0 1px 2px rgb(27 34 44 / 7%)` | `inset 0 1px 2px rgb(7 11 18 / 32%)` | 统一 `.searchbar`、`.search-input`、`.field` 与 `.panel-field` 输入框内凹边界 |
| `--scrim` | `rgb(15 23 36 / 42%)` | `rgb(7 11 18 / 65%)` | 弹窗遮罩底色 |

### Primitive & Component Contracts

- **`ContextMenu`**（`apps/web/src/ui/ContextMenu.tsx`，基于 `radix-ui`）：外框 `--surface-elevated`、`1px solid var(--border-strong)`、`--radius-md`、`--shadow-md`、`min-width: 196px`、`collisionPadding={8}`；保留 `.context-menu` 类名、`role="menu"`、`role="menuitem"` 与既有中文标签；顶部带 `FileTypeIcon` 与单行截断文件名（`title` 展示完整路径）；菜单项高 `30px`，左侧 `14px` 图标；危险操作「删除」使用 `--status-error-fg` 与 `--danger-subtle` 悬停底；通过 `opensDialog` 在打开弹窗时阻止关闭菜单抢回焦点。
- **`Dialog`**（`apps/web/src/ui/Dialog.tsx`，基于 `radix-ui`）：统一收口重命名、删除、新建书、替换图片与 `VersionHistory` 大弹窗；`--scrim` 遮罩 + `--surface-elevated` + `--radius-lg` + `--shadow-lg`；普通表单/确认框 `max-width: 440px`，`VersionHistory` 保留 `wide` 视口（`min(1100px, calc(100vw - 32px))`，移动端收窄至 `calc(100vw - 16px)`）；右上角提供 `X` 关闭按钮（`aria-label="关闭"`），底部操作区右对齐（`Button variant="ghost"` 取消在左，主按钮或 `variant="danger"` 在右）；当传入 `ariaLabel` 时显式置空 `aria-labelledby` 以保持 E2E 选择器稳定。
- **`Button` & 表单控件**：`Button`（`apps/web/src/ui/Button.tsx`）支持 `variant="primary" | "secondary" | "ghost" | "danger"` 与 `size="sm" | "md" | "lg"`；输入框统一 `--radius-md`、`--shadow-inset` 与 `focus-visible` 2px `--accent-subtle` 外环。
- **工作区、面板与书库组件**：`FileTree` 使用共享 `FileTypeIcon`（`apps/web/src/ui/FileTypeIcon.tsx`）与圆角胶囊高亮；`TabBar` 与 `.sidebar-tabs` 统一为 `38px` 高度，隐藏原生横向滚动条、支持鼠标滚轮横向滚动与活动胶囊自动滚入可视；顶栏/状态栏补齐分组分隔线与图标并在 `<= 680px` 隐藏超长书名与已保存时间以保证窄屏零溢出；`Editor.tsx` 的 `sidebarBody()` 在非文本资源下显示引导提示而不重复渲染 `MediaPane`；右侧 5 面板、`VersionHistory`、`BookCard`、`EmptyState`、`SearchBar` 与 `Login` 全部按上述层级与图标规范完成升级。

### State Matrix

| 组件 | default | empty | loading | error | edge |
|---|---|---|---|---|---|
| `ContextMenu` | 图标 + 分组 + 高亮当前项 | — | 同步展开 | 操作报错转弹窗或状态栏 | 贴边 `collisionPadding={8}` 回拉；非 spine 禁用上移/下移；二进制禁用历史 |
| `Dialog` | 标题 + 右上角关闭 + 右下角动作 | 删除无引用提示 | 提交按钮禁用 + 进行中文案 | 表单内联 `.banner-error` | 引用清单 `max-height: 220px` 内部滚动；`Escape`/遮罩关闭 |
| `BookCard` / `Library` | 封面卡微阴影 + 悬停抬升 | 限宽 `38ch` 图标徽章 + 主操作 | 保持封面比例骨架 | 顶部错误条 + 重试 | 超长书名 2 行截断 + `title`；下载按钮悬停/键盘聚焦/触屏可见 |

## Alternatives considered

- **维持彻底扁平校样台，仅微调间距与边框**：保留零阴影与单 `4px` 圆角不能改善右键菜单、弹窗、文件树与表单控件"像未完成原型"的立体感落差，用户明确选择转向现代桌面编辑器质感。
- **连同主色相一起重做（如暖纸白或高饱和紫/青色系）**：现有冷灰 + 墨蓝在长时间代码/预览对照下护眼且已完成 CodeMirror 语法高亮配比，更换色相增加返工成本且无助于解决层次与控件工艺短板。
- **仅改 CSS 不抽通用原语，或纯手写 `Dialog`/`ContextMenu`**：不抽组件会让 4 处弹窗行为继续漂移；手写门户、焦点陷阱与菜单碰撞定位在 React 19 下维护成本高于成熟的 `radix-ui` 统一包。
- **自研小型 SVG 图标文件替代 `lucide-react`**：全站精修覆盖菜单、文件树、Tab、目录操作、校验状态与弹窗关闭等二十余处图标，手工维护 SVG path 易出现线宽与光学对齐不一致。
- **单次大改一次性交付全站**：跨 18+ 文件的视觉方向切换若在早期细节需微调，返工代价高；拆分为「底座 + 浮层/核心工作区」与「面板/书库/登录」两阶段先做视觉校准。

## Consequences

**验收结果（2026-11-20）**

- `pnpm -r build` & `pnpm -r typecheck`（`packages/core`、`apps/server`、`apps/web`）全部通过。
- `pnpm vitest run` 17 个文件、186 条单测全部通过（含 `tokens.test.ts` 51 条浅/暗 ≥4.5:1 对比度与完整 token 断言）。
- `pnpm exec playwright test` 全库 60 条端到端用例全部通过（并在最终核验中修复了 `editor.spec.ts` 暴露出的两处既有基线问题：`sidebarBody()` 重复渲染 `MediaPane` 与首行选区点击定位）。
- `node e2e/audit-shots.mjs` 输出 `audit: clean`，在 `1440px`、`400px` 与暗色模式下零横向溢出、零断图、零前端/HTTP 报错；用户已在在线工作台与渲染截图上完成人工目视验收。

**代价与已知限制**

- 引入了 `lucide-react` 与 `radix-ui` 两个前端运行依赖，并由 `Dialog.tsx` 与 `ContextMenu.tsx` 显式透传 `aria-label`（置空 `aria-labelledby`）维持现有 E2E 可访问性名称契约，后续新增弹窗若传 `ariaLabel` 须沿用该包装组件。
- `TabBar` 隐藏了原生横向滚动条以防止其挤占标签高度，窄窗口打开大量文件时依赖鼠标滚轮横向滚动或文件树切换定位。
- 暗色浮层质感依赖 `--surface-elevated`（`#2b3544`）与 `--shadow-md`/`--shadow-lg` 的顶部 `1px` 内高光；未来新增抬升表面时需保持 `--text-muted` 对比度 ≥4.5:1（见 `tokens.test.ts`）。

**后续演进（2026-11-20）**

- 本文档中的「冷灰 + 墨蓝色板」「`4 / 6 / 10px` 圆角与 `26 / 30 / 36px` 控件高度」及「常驻三栏 + 右侧 5-Tab 栏 + 底部 `28px` 状态栏」壳层约束已由 [the Soft Craft Studio UI decision](2026-11-20-soft-craft-studio-ui.md) 部分替代；本文档确立的 Radix `Dialog` / `ContextMenu` 无障碍包装契约、`lucide-react` 图标体系及 `--surface-elevated` / `--danger*` / `--shadow-inset` 语义 Token 命名继续沿用。
