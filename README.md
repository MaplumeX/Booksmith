# Booksmith

自托管的 EPUB 编辑器：浏览器里编辑，书存在自己的 Postgres 里，每个文件各有一份可回滚的历史。

## 能做什么

- 登录后进封面墙书库：导入 EPUB、新建空白书、搜索书名/作者。
- 三栏工作台：文件树（Text / Styles / Images / Other）+ CodeMirror 编辑 + 右栏「预览 / 查找 / 元数据 / 目录」。
- 预览按书的 CSS 渲染当前章，图片、字体、MathML 都会正确加载。
- 全书查找（正则、区分大小写）与当前文件替换（⌘F）。
- 元数据表单只重写 OPF 的 `dc:*` 字段，目录改名同时同步 `nav.xhtml` 与 `toc.ncx`。
- 停手 20 秒后自动保存（两次自动保存至少间隔 3 分钟），未落库的输入另存于浏览器 IndexedDB，刷新或崩溃后可找回。
- 保存时服务端校验 zip / mimetype / container / OPF；内容没变则不写库、不升版本；后保存者收到 409 冲突而不是覆盖。
- 快照按文件记录：xhtml / opf / nav / ncx / css 各有自己的历史，可单独恢复某一版（恢复本身也是一条新快照）。

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

端到端使用 `e2e@booksmith.local` 账号，需要把它加进 `ALLOWED_EMAILS`。真实书样本随仓库提交在
`fixtures/`，无需额外准备。

## 部署

`docker-compose.yml` 起 Postgres + 应用（应用容器内托管构建好的前端）。主机需要 Docker 与
compose v2，没别的依赖。

**1. 拿 compose 文件**（只需要这一个文件，不需要构建源码）

```bash
git clone https://github.com/MaplumeX/Booksmith.git && cd Booksmith
```

**2. 写 `.env`**（compose 自动读取；`.env` 已在 `.gitignore` 里）

```bash
POSTGRES_PASSWORD=<openssl rand -base64 24>
ALLOWED_EMAILS=you@example.com
AGENT_SECRET_KEY=<openssl rand -hex 32>    # 不填则无法在设置里保存模型 API Key
COOKIE_SECURE=true                         # 跟在 HTTPS 反代后面才开
BOOKSMITH_IMAGE=ghcr.io/maplumex/booksmith:0.1.1
```

`POSTGRES_PASSWORD` 是必填的，缺了 compose 会直接报错退出。`ALLOWED_EMAILS` 为空则任何人都注册不了。

**3. 起服务**

```bash
docker compose pull app
docker compose up -d --no-build
curl -sf http://127.0.0.1:8787/api/health    # → {"ok":true}
```

迁移在容器启动时自动执行（`CMD` 里先跑 `db:migrate`），首次启动后看 `docker compose logs -f app`
里应有 `migrations applied` 与 `booksmith server on http://0.0.0.0:8787`。

**4. 反向代理**（应用只绑 `127.0.0.1:8787`，不直接对外）

Caddy：

```
books.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

nginx：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 64m;      # 与服务端 MAX_UPLOAD_BYTES 对齐，否则大书上传 413
  proxy_buffering off;           # agent 对话是 SSE，缓冲会让它变成一次性刷出来
}
```

服务端已发 `X-Accel-Buffering: no`，但显式关掉更稳。

## 升级与回滚

```bash
git pull
# 改 .env 里的 BOOKSMITH_IMAGE 为新 tag
BOOKSMITH_IMAGE=ghcr.io/maplumex/booksmith:0.2.0 docker compose pull app
docker compose up -d --no-build
```

迁移随容器启动自动跑。**数据库迁移是单向的**：升级后回退镜像不会回退 schema，带不兼容迁移的版本
回退前先备份。回滚镜像：

```bash
BOOKSMITH_IMAGE=ghcr.io/maplumex/booksmith:0.1.0 docker compose up -d --no-build
```

## 发版

推一个 `v*` tag，`.github/workflows/release.yml` 构建镜像并推到 GHCR：

```bash
git tag v0.1.1
git push origin v0.1.1            # → ghcr.io/maplumex/booksmith:0.1.1 / 0.1 / latest
```

`workflow_dispatch` 手动跑一次则只打 `edge`（用于上线前验证流水线）。`linux/amd64` 单架构，
要 arm64 就在 workflow 里加 `platforms` 的一行；镜像仍以 tar 形式包含 devDependencies 与 `tsx`，
要减体积得改成多阶段构建。

GHCR 包默认随仓库可见（public 仓库即 public），拉取无需登录。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DATABASE_URL` | `postgres://booksmith:booksmith@127.0.0.1:55432/booksmith` | Postgres 连接串（compose 里指向 `db:5432`） |
| `ALLOWED_EMAILS` | 空（不允许注册） | 逗号分隔的注册白名单 |
| `PORT` | `8787` | API 端口 |
| `HOST` | `0.0.0.0` | 监听地址（容器内必须保持 `0.0.0.0`，否则端口映射连不上） |
| `COOKIE_SECURE` | `false` | 仅 HTTPS 下发送会话 cookie |
| `SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `AGENT_SECRET_KEY` | 空（禁用加密保存 API Key） | 32 字节密钥（`openssl rand -hex 32`），AES-256-GCM 加密用户模型 API Key |
| `WEB_DIST` | 空 | 设置后由 Fastify 托管该目录的静态前端 |

## 备份

书籍二进制与版本都在数据库里，所以一份 dump 就是全量备份：

```bash
# 开发（embedded Postgres）
DATABASE_URL=… ./scripts/backup.sh

# 服务器（dump 在 db 容器里跑，直接写宿主机）
docker compose exec -T db pg_dump --no-owner -U booksmith -Fc booksmith > backups/booksmith-$(date -u +%Y%m%dT%H%M%SZ).dump
```

恢复：

```bash
docker compose exec -T db pg_restore --clean --if-exists --no-owner -U booksmith -d booksmith < backups/booksmith-….dump
```

每个文件保留最近 100 条快照：最近 10 条全留，更早的每天留最后一条；同一文件十分钟内的连续保存合并为一条。整本书只保留当前状态一行。

## 许可

AGPL-3.0-or-later。改动后作为网络服务提供时，需要一并公开你的修改。
