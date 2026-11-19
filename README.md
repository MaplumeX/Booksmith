# Booksmith

自托管的 EPUB 编辑器：浏览器里编辑，书存在自己的 Postgres 里，每次保存留一个可回滚的版本。

## 能做什么

- 登录后进封面墙书库：导入 EPUB、新建空白书、搜索书名/作者。
- 三栏工作台：文件树（Text / Styles / Images / Other）+ CodeMirror 编辑 + 右栏「预览 / 查找 / 元数据 / 目录 / 版本」。
- 预览按书的 CSS 渲染当前章，图片、字体、MathML 都会正确加载。
- 全书查找（正则、区分大小写）与当前文件替换（⌘F）。
- 元数据表单只重写 OPF 的 `dc:*` 字段，目录改名同时同步 `nav.xhtml` 与 `toc.ncx`。
- 保存时服务端校验 zip / mimetype / container / OPF，加入新版本；后保存者收到 409 冲突而不是覆盖。
- 版本列表可恢复任意历史版本（恢复本身也是一个新版本）。

不支持、也不打算支持：富文本可视化编辑、中文排版规则引擎、EPUBCheck 集成、协作编辑。

## 技术栈

```
apps/web      Vite + React + CodeMirror 6
apps/server   Fastify + Drizzle + Postgres（书籍二进制存 bytea）
packages/core EPUB 引擎（前后端同构）
```

## 本地开发

需要 Node 22 与 pnpm。**不需要 Docker** —— 开发库由 `embedded-postgres` 在 `.pgdata/` 里拉起。

```bash
pnpm install

# 1. 数据库（前台运行，Ctrl+C 停止）
pnpm --filter @booksmith/server db:dev

# 2. 迁移
pnpm --filter @booksmith/server db:migrate

# 3. API（另开一个终端）
DATABASE_URL=postgres://booksmith:booksmith@127.0.0.1:55432/booksmith \
ALLOWED_EMAILS=you@example.com \
pnpm --filter @booksmith/server start

# 4. 前端（再开一个终端）
pnpm --filter @booksmith/web dev
```

打开 http://127.0.0.1:5173 。注册入口只对 `ALLOWED_EMAILS` 里的邮箱开放，用其中一个邮箱注册一次即可。

忘记密码：

```bash
echo 'new-password' | pnpm --filter @booksmith/server reset-password you@example.com
```

## 测试

```bash
pnpm -r typecheck
pnpm vitest run                        # core + web 单元测试
pnpm --filter @booksmith/server test   # API 集成测试，自起临时 Postgres
pnpm playwright test                   # 端到端，需要 API 已在 8787 运行
node e2e/audit-shots.mjs               # 1440 / 400 截图与溢出、断图、console 审计
```

端到端使用 `e2e@booksmith.local` 账号，需要把它加进 `ALLOWED_EMAILS`。真实书样本放在
`fixtures/`（`.gitignore` 已排除，获取方式见 `fixtures/README.md`）。

## 部署

`docker-compose.yml` 起 Postgres + 应用（应用容器内托管构建好的前端）。

```bash
POSTGRES_PASSWORD='…' ALLOWED_EMAILS='you@example.com' docker compose up -d
docker compose exec app pnpm --filter @booksmith/server db:migrate
```

对外暴露时把 `COOKIE_SECURE=true` 并放在 HTTPS 反向代理后面。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DATABASE_URL` | `postgres://booksmith:booksmith@127.0.0.1:55432/booksmith` | Postgres 连接串 |
| `ALLOWED_EMAILS` | 空（不允许注册） | 逗号分隔的注册白名单 |
| `PORT` | `8787` | API 端口 |
| `COOKIE_SECURE` | `false` | 仅 HTTPS 下发送会话 cookie |
| `SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `WEB_DIST` | 空 | 设置后由 Fastify 托管该目录的静态前端 |

## 备份

书籍二进制与版本都在数据库里，所以一份 dump 就是全量备份：

```bash
DATABASE_URL=… ./scripts/backup.sh
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" backups/booksmith-*.dump
```

版本保留最近 20 个（`pinned` 的永久保留）。

## 许可

AGPL-3.0-or-later。改动后作为网络服务提供时，需要一并公开你的修改。
