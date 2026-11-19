# ADR: AGPL-3.0 license for a self-hostable editor

Status: implemented

## Problem

Booksmith 是自托管的服务端 + 浏览器编辑器：代码一旦部署到一台服务器，用户拿到的就是服务而
不是二进制。在这种情况下，宽松许可证（MIT/Apache-2.0）允许第三方把它包装成付费 SaaS 并
闭源维护自己的改动，项目作者无法从改进中受益。

同时这是个人项目，没有商业计划，也没有法务团队；许可证必须是一个不需要 CLA、不需要商标
条款、GitHub 模板即可完成的选择。

## Decision

采用 **AGPL-3.0**。仓库根有未经修改的全文 `LICENSE`（661 行，取自 gnu.org），
`package.json` 与三份 workspace 包的 `package.json` 声明 `"license": "AGPL-3.0-or-later"`，
README 的许可段落用白话说明三个场景：可自托管、可修改、修改后作为网络服务提供时必须开源。

## Alternatives considered

**MIT**。最容易获得贡献者，也最常用。但它对"以服务形式分叉"没有任何约束，而 Booksmith
的产品形态恰好就是服务；许可证与威胁模型不匹配。

**Apache-2.0**。比 MIT 多专利授权条款，仍不覆盖网络服务场景。

**BUSL / 自定义非商业许可**。不是 OSI 认证的开源许可，会阻断发行版打包与社区贡献，且个人
项目无资源执行自定义条款。

**暂不设置许可证**。默认版权等于"保留一切权利"，与"开源"直接矛盾，也会让贡献者无法安全使用。

## Consequences

- 仓库根存在未修改的 AGPL-3.0 全文；根 `package.json` 与 `apps/web`、`apps/server`、
  `packages/core` 的 `license` 字段均为 `AGPL-3.0-or-later`。
- README 说明自托管、修改、网络服务三个场景的义务。
- 部分公司禁止使用 AGPL 依赖，可能限制未来的企业采用或贡献；若出现明确的企业协作需求，
  再考虑双许可——按 `.agents/ADR/AGENTS.md` 新增一条记录，不改写本记录。
- AGPL 的"网络服务"边界在自托管多用户场景下没有判例，执行依赖社区共识而非诉讼。
