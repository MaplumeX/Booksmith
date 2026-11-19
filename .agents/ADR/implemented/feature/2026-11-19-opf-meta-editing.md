# ADR: Editing OPF meta and refines

Status: implemented

## Problem

元数据面板只覆盖 `dc:*`。`packages/core/src/opfWrite.ts` 的 `writeOpfMetadata` 明确「只重写表单
拥有的字段」，这是对的；但结果是 OPF 里另一半元数据只能去 XML 里手改：

- `dcterms:modified` —— EPUB 3 要求它存在且反映最后一次修改。`create.ts:46` 在新建书时写一次
  时间戳，之后**永远不再更新**。一本改了三天的书仍在声称自己是创建那天最后修改的。
- `<meta property="role" refines="#creator">aut</meta>` —— 作者角色。删一个作者时
  `repeated()` 会带走它的 `refines`，但新增作者、改角色没有入口。
- `ibooks:*` —— Apple 的显示选项（`specified-fonts`、`flow`）。
- `<meta name="cover" content="cover-image"/>` —— EPUB 2 的封面声明，改封面后要跟着改。

## Decision

**一张 `meta` 行表，加一条关于时间戳的明确规则。**

- `MetadataPanel` 在现有 `dc:*` 表单下增加 `meta` 区块：每行可编辑 `property`（或 `name`）、
  `refines`（下拉选择 `#id` 或留空）、值。可增行、删行。只改用户碰过的行，其余 `<meta>` 原样
  保留顺序与属性。
- 新函数 `writeOpfMeta(xml, rows, codec)` 与 `writeOpfMetadata` 并列，职责不重叠：前者管
  `<meta>`，后者管 `<dc:*>`。
- **`dcterms:modified` 只在 OPF 自身被编辑时刷新**（`dirty` 里包含 `opfPath` 的那次保存，写入
  当前时间）。不在每次保存都刷新。

**为什么不在每次保存刷新时间戳。** 每次保存都改 OPF 会让「内容没变则不写库、不升版本」的服务端
优化永久失效：客户端打包时 OPF 字节已变，服务端看到的是一个不同的包，于是每个空保存都升一版，
每个文件都多一条快照。规范要求的是「最后修改时间」，而一次 OPF 未变的保存不构成对这本书记录的
修改。手动点「保存」时若确实改了 OPF，时间戳会随之下一次一起更新。

## Alternatives considered

**每次保存都刷新 `dcterms:modified`（严格合规做法）。** 合规，但会让每本书的每次自动保存都产生
一条 `opf` 快照（`hasPageHistory('x.opf')` 为真），并在 100 条上限下把真实历史挤出去。自动保存
是停手 20 秒就触发的，代价是历史被空操作淹没。这与
[自动保存决策](2026-11-19-autosave.md) 的整个前提冲突。

**完全不暴露 `meta`，只提供「刷新时间戳」按钮。** 便宜，但 `role` 与 `ibooks:*` 仍然是手改
XML。用户当下就卡在这里（多作者书里 role 是必需信息）。

**把 `meta` 做成自由 key-value 表，不做语义分组。** 已经是本提案的形态：EPUB 的 `meta` 词汇表
是开放的（`property` 来自任意 vocabulary），任何预设字段列表都会漏。分组只做「常用 / 其他」
的视觉提示，不限制可编辑范围。

## Consequences

**交付实测（2026-11-19）**

- `readOpfMeta` / `writeOpfMeta` / `touchOpfModified` 共 10 个单测，覆盖新增 property 与 legacy form、删行、忽略空行。
- 真实书：只改正文的保存保持 `2026-10-20T12:21:50Z` 不变；改书名后保存更新到当前时间（e2e）。
- 面板在 `metadata` / `version` 变化时重读，输入过程中不重读，避免抹掉半填的行。

**已接受的代价**

- `refines` 指向的 `#id` 可能不存在（用户手填）。这是合法的 OPF，但会让阅读器忽略该 `meta`。
  检查面板不对此报警——它不是结构错误，是语义问题，报警会变成噪声。
- 时间戳规则依赖「OPF 是否在 dirty 集合里」，这是一个隐式条件。UI 上在 `dcterms:modified`
  行旁写一行说明，避免用户困惑「为什么这次没更新」。
