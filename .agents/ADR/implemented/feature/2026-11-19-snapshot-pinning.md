# ADR: Pinning page snapshots

Status: implemented

## Problem

快照按 100 条剪枝，重要的那一版会被时间挤掉。`apps/server/src/storage/fileStore.ts` 的
`prunePages` 保留最近 10 条，更早的每天留最后一条，上限 `PAGE_CAP = 100`。一次校对会话会在同一
章上产生几十条快照，「改坏之前的那一版」在几小时后就被同一天的后续保存覆盖掉。

[快照历史决策](2026-11-19-snapshot-history.md) 描述过 `pinned` 列、
`FileStore.markPinned()` 与「剪枝时保留 pinned」的逻辑，并把「界面上没有标记/取消的 API 与按钮」
列为遗留项。**那段描述与现场不符**：`page_versions` 表没有 `pinned` 列
（`apps/server/src/db/schema.ts:68-84`），`FileStore` 接口里也没有 `markPinned`
（`storage/fileStore.ts:8-21`）——这些在页面级快照重构时被删掉了。所以本记录不是「补一个按钮」，
是从存储到界面的一整条链路。

## Decision

**加一列，剪枝时给它豁免，列表上给一个图钉。**

- `page_versions.pinned boolean not null default false` + `drizzle-kit generate` 产出一份迁移。
- `FileStore.setPinned(bookId, snapshotId, pinned)`；`prunePages` 的删除集合排除 `pinned = true`。
  `pinned` 快照不占那 100 条的额度，也不参与按天稀疏。
- `PATCH /api/books/:id/page-versions/:snapshot`，body `{ pinned: boolean }`，返回更新后的行。
  鉴权与归属检查沿用现有 `findOwnedBook`。
- `VersionHistory` 每行加图钉按钮，状态与列表一起返回；`PageSnapshotDto` 加 `pinned` 字段。

**不做命名快照。** [旧决策](2026-11-19-snapshot-history.md) 已否决
「给快照起名字」，理由是那会引入一套需要维护的命名语义；图钉只表达「别删我」，不需要名字就能
达到目的。

## Alternatives considered

**不做，100 条够用。** 对单人自托管，一个文件 100 条确实不算少；但剪枝规则是「最近 10 条全留
+ 每天最后一条」，一次密集会话里真正想留的那版通常不是当天的最后一条。用户要的是「我知道这一
版是对的」这个显式动作，而不是靠运气。

**按时间自动保护（例如每章第一次修改的快照永不被删）。** 隐式规则，用户无法控制，也无法让
「我刚才特意留下的那版」与「随机留下的那版」区分开。

**命名快照 / 分支。** 已否决，理由见上。重开这个口子会让快照从一个时间轴变成一棵树，UI 与
存储都要翻倍。

**存在浏览器本地（localStorage / IndexedDB）。** 换设备就没了，而这正是服务端快照要解决的。

## Consequences

**交付实测（2026-11-19）**

- `0005_brainy_human_torch.sql` 只含一条 `ADD COLUMN`；dev 库迁移后书籍与历史数据完好。
- 120 条 + 1 置顶 → 保留 11 条、删 109；取消置顶后重新可删（单测）。
- `PATCH` 覆盖 200 / 400 / 404 / 401；图钉状态刷新后保持（2 条 e2e）。

**已接受的代价**

- 迁移是本次唯一改动外部持久状态的一步。加列带默认值、不重写既有行，回退只需 `DROP COLUMN`。
- 无上限的图钉会让某个文件的快照无限增长（每次保存 84KB 量级）。第一版不设上限，但 UI 上把
  图钉数与总体积写进面板说明；若真实使用中图钉超过几十条，再加一个上限就是一行查询。
