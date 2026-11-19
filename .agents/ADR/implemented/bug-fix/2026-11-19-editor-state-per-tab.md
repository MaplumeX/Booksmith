# ADR: One editor state per open tab

Status: implemented

## Problem

切换文件会清空撤销历史。`apps/web/src/ui/CodePane.tsx:52` 的 `useEffect` 依赖 `[path, editorTheme]`，
每换一个文件就 `destroy()` 旧 `EditorView` 再 `new EditorView(...)`。CodeMirror 的 history 活在
`EditorState` 里，随 view 一起销毁，所以：

1. 在 `ch003.xhtml` 里删掉一段；
2. 点开 `ch004.xhtml`，再点回 `ch003.xhtml`；
3. ⌘Z ——什么都没发生。

用户对编辑器最基本的预期是「我刚才那一下能撤销」。当前实现让这个预期在切换文件后失效，而
切换文件正是校对时的常规动作（对照两章、改完回来）。用户会认为编辑器吞了输入。

现有的注释已经把原因写在代码里：「Rebuilding per path keeps one document per file; typing never
re-creates the view.」这个设计解决了「一个文件一份文档」，代价是每次切换丢掉撤销栈。

## Decision

**按路径缓存 `EditorState`，切换时 `view.setState()`。**

- `CodePane` 持有 `Map<path, EditorState>`。切走时把当前 `view.state` 存回 map，切回时用
  `view.setState(cached)` 还原；文档、选区、撤销栈一起回来。
- 首次打开的路径照旧 `EditorState.create({ doc: content, extensions })`。
- 外部改写了某个文件的文本（全书替换、快照恢复、引用重命名）时，用 `syncDoc(path, text)`：
  若该文件正打开，以 `setState` 重建它的 state——这会清掉该文件的撤销栈，但外部改写本身
  不是一个可递增的编辑，保留旧撤销栈会让「撤销」把外部改写之前的内容写回去，比清空更危险。
- `path` 仍是 `EditorState` 的键，不引入新的身份概念。

## Alternatives considered

**保留所有打开过的 view，只是隐藏。** 撤销栈天然保留，代码更少（不碰 state 缓存）。但每个
view 都是一整套 DOM 与滚动容器，28 章各开一次就是 28 个编辑器实例；`ch010.xhtml` 是 174KB，
内存与切换开销都不可控。

**给每个文件单独装一个 history 字段（compartment）。** 让一个 view 在不同文件间切换时载入
各自的撤销栈。技术上可行，但要手工管理 compartment 的 reconfigure 时机，且必须保证
「撤销不能跨文件」——这恰好是缓存整个 `EditorState` 免费得到的东西。多出的机制没有换回
任何东西。

**不修，靠用户自己小心。** 这不是「缺功能」而是行为错误：用户在同一个文件里操作时撤销有效，
换个文件再回来就失效，是同一动作在两种上下文里表现不一致。

## Consequences

**交付实测（2026-11-19）**

- 切 tab 后 ⌘Z 撤销的是切走前的输入，选区一并恢复（2 条 e2e）。
- 全书替换等外部改写通过 `content` prop 差异重设 state，撤销栈随之清空。
- `EditorState` 缓存按路径持有，tab 关闭时删除。

**已接受的代价**

- `EditorState` 持有整份文档字符串，28 章全开约 2MB 量级，可接受；但每份 state 还持有语法树
  缓存，长期开着 28 个 tab 会有内存增长。缓解：切走的 state 保留，但 tab 关闭时从 map 删除。
- 外部改写会清空该文件的撤销栈，这是有意为之：撤销外部改写会把旧内容写回去。全书替换的回退
  由它自己的批次快照负责（见 [全书替换](../feature/2026-11-19-book-wide-replace.md)）。
