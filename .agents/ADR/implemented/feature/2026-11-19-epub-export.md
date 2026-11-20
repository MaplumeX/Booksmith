# ADR: Download the current EPUB

Status: implemented

## Problem

书只能进不能出。书库有导入、有新建，编辑器能改能存，但没有任何「把这本书拿走」的入口：
`apps/server/src/routes/books.ts` 的 `GET /api/books/:id/epub` 只被前端 `loadBook` 使用，
不带 `content-disposition`；书库卡片与顶栏都没有下载动作。

对自托管的编辑器这是硬伤：用户把书交进来之后，没有不经过数据库 dump 就能拿回它的路径。
换工具、发给别人、交给阅读器验证，三件事都做不到。

## Decision

**一个只读端点 + 两个入口。**

- `GET /api/books/:id/download` 返回当前已保存的整包，头：
  `content-type: application/epub+zip`、
  `content-disposition: attachment; filename*=UTF-8''<percent-encoded-title>.epub`。
  同时给 `filename="book.epub"` 作为不理解 `filename*` 的客户端的兜底。（*更新：依据 [entry-level book storage](../architecture/2026-11-20-entry-level-book-storage.md)，该端点现按 `book_entries.position` 实时打包输出，原内部读取端点 `GET /api/books/:id/epub` 已下线。*）
- 入口两处：书库卡片菜单/动作、编辑器顶栏。都用同源 `<a download href="...">` 触发，
  不经过 fetch，避免把 2MB 整包读进 JS 再拼 blob。
- 文件名取 `book.title`，去掉归档非法字符（`/ \ : * ? " < > |`），空标题回退 `book.epub`。

**导出的是服务端当前版本，不是浏览器里的未保存改动。** 有未保存改动时，入口的 `title`
写明「下载已保存版本（N 个文件未保存）」，并在点击前不自动保存——静默保存会把一次「我只想
拿走上次那版」变成一次版本递增。

## Alternatives considered

**前端拼 blob：用 `api.epub()` 取回整包再 `URL.createObjectURL`。** 可行，但等于把 2MB 读进
内存再写出去，而且下载的文件名要靠 `a.download` 自己设，与浏览器原生下载管理器的交互更差。
服务端直出是零成本的。

**复用 `GET /api/books/:id/epub` 加 `?download=1`。** 一个端点两种语义：带 ETag 的资源读与
一次性附件下载。ETag 与缓存语义只对前者有意义，混在一起会让之后想加缓存的人踩坑。多一条路由
更清楚。

**导出时把未保存改动也包含进去（前端打包后上传再下载）。** 那是一个「保存并导出」动作，语义
上应该由用户显式保存触发；混进下载按钮会让版本历史里出现来路不明的一版。

## Consequences

**交付实测（2026-11-19）**

- `GET /api/books/:id/download` 返回完整包（sha256 与上传一致），`content-disposition` 同时给 `filename` 与 RFC 5987 的 `filename*`。
- 书库卡片与编辑器顶栏各一个入口，中文文件名在 Chromium 下正确。
- 外部阅读器打开未验证：waived by user（本机无 Calibre / Thorium，已验 `PK` 头与 700 KB 完整字节）。

**已接受的代价**

- `content-disposition` 的中文编码是这条最容易出问题的地方：`filename` 用拉丁兜底、
  `filename*` 用 RFC 5987 编码，两者都要有。若 Chromium 仍落成乱码，停下来换方案而不是
  在客户端做文件名改写（那会绕过浏览器下载管理器）。
- 2MB 整包直出在单实例下没有压力；没有 Range 支持，断点续传不适用。
