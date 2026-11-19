# 部署与运维

## Docker Compose

在仓库根目录运行 `node scripts/setup.mjs` 生成私有 `.env`，然后配置模型服务密钥。没有 Node.js 时，可以在 Linux 或 macOS 上使用临时容器。让容器以当前用户运行，确保主机上的 Compose 可以读取生成的私有文件。

```sh
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$PWD,target=/work" -w /work node:24-alpine node scripts/setup.mjs
```

Windows PowerShell 使用以下命令。

```powershell
docker run --rm --mount "type=bind,source=$PWD,target=/work" -w /work node:24-alpine node scripts/setup.mjs
```

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

默认入口为 `http://localhost:8088`。迁移服务 `migrate` 成功后退出，API、三类 Worker、Web 代理和 PostgreSQL 持续运行。访问 `/api/health` 可检查 API 是否可达，并通过 `workerReady`、`backgroundWorkerReady`、`fileWorkerReady` 查看执行进程是否就绪。生产 Compose 将数据库端口保留在内部容器网络。

## 公网 HTTPS

将域名解析至服务器，开放 TCP 80 和 443。在私有 `.env` 中写入以下配置，并将域名换成你的部署域名。

```dotenv
SITE_ADDRESS=nota.example.com
APP_URL=https://nota.example.com
HTTP_PORT=80
HTTPS_PORT=443
```

更新后运行 `docker compose up -d --build`。Caddy 为域名配置 HTTPS。请将 `APP_URL` 设为浏览器实际访问的 HTTPS 地址，以启用安全 Cookie。浏览器通过 HTTPS 请求麦克风权限。开放注册由 `ALLOW_REGISTRATION` 控制，已有账号可在设为 `false` 后继续登录。

已有宿主机 HTTPS 代理时，可用 `docker compose -f compose.yaml -f compose.server.yaml up -d --build`。该覆盖文件需要支持 `!override` 的 Docker Compose，将应用 HTTP 入口绑定到 `127.0.0.1:18088`，端口由 `NOTA_HTTP_PORT` 调整。可参考 [Nginx 配置示例](../deploy/nginx/nota.conf)，替换域名和证书路径。若采用 HTTP-01 签发证书，可先使用 [HTTP 示例](../deploy/nginx/nota.http.conf)。代理应传递外部协议和主机信息，并关闭 SSE 响应缓冲。

## 本地开发

需要 Node.js 24、pnpm 10、Docker Compose v2、`ffmpeg` 和 `ffprobe`。从完整 Compose 切换到本地进程前，执行 `docker compose stop api worker task-worker file-worker web`，使应用进程在同一文件系统内访问音频和会话。

```sh
node scripts/setup.mjs
pnpm install --frozen-lockfile
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
pnpm db:migrate
pnpm dev
```

Vite 监听 `127.0.0.1:5179`，将 `/api` 代理给 `127.0.0.1:3031`。开发覆盖文件将数据库映射到本机 `127.0.0.1:54330`，与生成的 `DATABASE_URL` 一致。若 FFmpeg 工具未加入 PATH，可通过 `FFMPEG_PATH`、`FFPROBE_PATH` 配置绝对路径。容器自带这两个程序。

## 主要配置

| 变量 | 用途 |
| --- | --- |
| `GMI_API_KEY`、`GMI_BASE_URL`、`GMI_MODEL` | 文本推理与工具调用。默认模型为 `deepseek-ai/deepseek-v4.1-flash-1017`。 |
| `LLM_CONTEXT_WINDOW`、`LLM_MAX_OUTPUT_TOKENS`、`LLM_COMPACT_RATIO` | 依据所选模型设置输入容量、最大输出和上下文压缩阈值。 |
| `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ASR_MODEL` | 音频转写，默认 `gpt-transcribe`。 |
| `EMBEDDING_ENABLED`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS` | 向量检索，默认启用 `text-embedding-3-small` 和 1536 维。可禁用向量索引并使用关键词检索。 |
| `TAVILY_API_KEY`、`TAVILY_TIMEOUT_MS` | 可选的网页搜索与正文读取。默认超时 20 秒。 |
| `MAX_UPLOAD_MB`、`MAX_AUDIO_SECONDS` | 默认限制为 24 MB 和 600 秒。 |
| `WORKER_CONCURRENCY`、`BACKGROUND_WORKER_CONCURRENCY`、`FILE_WORKER_CONCURRENCY` | 主 Agent、后台查询、文件任务的并发上限。 |
| `RECORDING_WINDOW_IDLE_MS` | 未满十条的录音窗口在成员到达终态后的等待时间，默认 1500 毫秒。 |
| `COOKIE_SECRET`、`POSTGRES_PASSWORD`、`DATABASE_URL` | 由初始化脚本生成的私有连接和签名配置。Compose 使用容器内部数据库地址。 |
| `BILLING_MODE`、`PAYMENT_WEBHOOK_SECRET` | 订阅模式及商户回调签名密钥。默认 `demo`，演示开通不收费。 |

更改应用配置后用 `docker compose up -d` 重新加载服务。密钥只写在私有 `.env` 中。检查 Compose 时使用 `docker compose config --quiet`，避免把展开的环境变量写入终端或日志。

## 备份

备份应包含 PostgreSQL、音频与 SDK 会话卷，以及单独保管的私有 `.env`。以下命令在 Linux 服务器上停止写入、复制备份并恢复服务。

```sh
mkdir -p backups
docker compose stop api worker task-worker file-worker
docker compose exec -T postgres pg_dump -U nota -d nota -Fc > backups/nota.dump
docker run --rm --mount type=volume,source=nota_nota-data,target=/data,readonly --mount "type=bind,source=$PWD/backups,target=/backup" alpine:3 tar czf /backup/nota-data.tar.gz -C /data .
docker compose up -d api worker task-worker file-worker
```

`nota_nota-data` 使用默认 Compose 项目名 `nota`。自定义项目名时请使用对应的卷名。恢复前先保存现有数据库和卷，再恢复数据库、数据及文件所有权。`docker compose down` 的 `-v` 选项会删除卷。

## 支付回调

`BILLING_MODE=webhook` 需要自行接入商户 checkout，并将平台事件转换后送到 `POST /api/billing/webhook`。请求体包含 `id`、`user_id`、`version`、`plan`、`status`、`period_end`、`cancel_at_period_end` 和 `subscription_ref`。签名头为 `x-nota-signature: t=unix_seconds,v1=hex_hmac_sha256`，签名原文为时间戳、点号和原始请求体。服务端验证五分钟窗口，并按事件 ID 去重、按订阅版本排序。
