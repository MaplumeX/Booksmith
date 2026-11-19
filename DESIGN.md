# Booksmith DESIGN

## 1. Product & Brand Context

**使用者**：长时间校对 epub 的编辑者，一人或小团队自托管。屏幕切成结构、文本、渲染三块，
眼睛在等宽代码与纸面预览之间反复切换。

**调性**：一张印刷校样台。冷灰纸面、1px 分割线替代阴影、单一墨蓝强调色。密度紧凑，工具感，
不是 SaaS 后台。

**文案**：直接、说清下一步。按钮用动词（「保存」「导入」「重新加载」），空态给出行动而不是
「暂无数据」，错误说清"发生了什么 + 现在能做什么"。

**不要做**：卡片阴影、渐变、彩色侧边条、弹窗装普通长内容、`transition: all`、纯黑 `#000`、
红绿单独表意、`Lorem ipsum`。

## 2. Tokens & Conventions

全部 token 在 `apps/web/src/styles/tokens.css`，组件只消费语义别名，禁止写死颜色。
色板与实测对比度见 `.agents/ADR/implemented/design/2026-11-19-workbench-design-system.md`。

- **主题**：`:root` 浅色，`[data-theme="dark"]` 覆盖语义别名。暗色不用阴影，用更浅表面 + 1px 边框。
- **文字三级**：`--text` / `--text-secondary` / `--text-muted`。`--neutral-500` 只用于图标与
  禁用态，永不承载正文。
- **强调**：`--accent` 用于主按钮与选中，`--accent-subtle` 用于选中背景。
- **状态**：`--status-{ok,error,warn}-{bg,fg}` 成对使用，浅底深字；必须配图标或文字，不单靠颜色。
- **字号**：`12 / 13 / 14 / 16`；UI 13，代码 13 等宽；行高 UI `1.45`、中文正文 `1.6–1.75`。
- **间距**：`--space-1..6` = `4 / 8 / 12 / 16 / 24`；控件高 `26 / 30 / 36`。
- **圆角**：只有 `--radius: 4px` 一档。
- **焦点**：`:focus-visible` 2px `--focus-ring` + `offset 2px`，从不全局 `outline: none`。
- **布局**：`100dvh` 三段式；顶栏 `44`、状态栏 `28`、文件树 `240`、预览 `400–560`。
  `<1024px` 预览收成 tab。
- **动效**：只动 `transform` / `opacity`，`150–200ms`；`prefers-reduced-motion` 下只保留透明度。

## 3. Component Index & State Matrix

| 组件 | 路径 | 状态 |
|---|---|---|
| `Button` | `src/ui/Button.tsx` | default / hover / active / focus-visible / disabled / loading |
| `FileTree` | `src/ui/FileTree.tsx` | default / empty（无图片组）/ loading / error / edge（长名截断）/ 右键菜单 |
| `TabBar` | `src/ui/TabBar.tsx` | default / active / dirty / overflow（横向滚动） |
| `CodePane` | `src/ui/CodePane.tsx` | default / loading / error（语法错误）/ edge（174KB 单章） |
| `PreviewPane` | `src/ui/PreviewPane.tsx` | default / empty / loading / error / edge（MathML、缺图） |
| `MetadataPanel` | `src/ui/MetadataPanel.tsx` | default / dirty / error（字段非法） |
| `TocPanel` | `src/ui/TocPanel.tsx` | default / empty / error（锚点失效）/ edge（标题含内联 MathML） |
| `SearchPanel` | `src/ui/SearchPanel.tsx` | default / empty / loading |
| `VersionHistory` | `src/ui/VersionHistory.tsx` | default（单文件时间轴 + diff）/ empty（这一版和现在相同）/ loading（列表与 diff 骨架）/ error（重试）/ edge（单文件 100 条、长行折行） |
| `FileTree` 右键菜单 | `src/ui/FileTree.tsx` `.context-menu` | default / disabled（二进制与容器条目无历史）/ hover / 键盘 `Escape` 与点击外部关闭 |
| `MetadataPanel` | `src/ui/MetadataPanel.tsx` | default / dirty |
| `Dialog` | 书库新建书 | default / pending / error |
| `StatusBar` | `src/ui/StatusBar.tsx` | 已保存 / 保存中 / 冲突 |
| 保存状态（顶栏） | `src/routes/Editor.tsx` `.appbar-save` | dirty（N 处未保存）/ saving（保存中…）/ saved（已保存 HH:MM）/ error（保存失败 · 重试） |
| `BookCard` | `src/ui/BookCard.tsx` | default / hover / loading（骨架）|
| `EmptyState` | `src/ui/EmptyState.tsx` | 图形 + 标题 + 说明 + 一个主操作 |

状态矩阵的完整定义（每个组件的五态行为）见设计 ADR。新增组件时必须在此表登记路径与已覆盖状态。
