# Nota

Nota 是一个可自托管的个人语音便签与 AI 助手。录下你的想法和约定，或直接用文字交办。Nota 将内容整理为带出处的便签、可更新的长期记忆，以及日历里的日程、待办和提醒。界面适配桌面与移动浏览器。

**推理由 GMI Cloud Inference Engine 提供**，用于 Nota 的对话、录音分析和后台查询。 [GMI Cloud 开发者文档](https://www.gmicloud.ai/en/developers)

## 功能

- **语音便签**支持浏览器录音、音频上传、离线暂存与恢复上传。转写可修订，摘要和行动保留原文出处，便于回听和复查。
- **持续对话**为每个账号保留独立会话。运行中可补充要求，工具回执、失败重试和最终答复都可在原对话查看。
- **日程、待办和提醒**支持月视图、周时间轴、全天事项与 ICS 导出。计划、截止和通知时间可以分别设置。
- **人物与记忆**保存来源和事实版本，支持同名人物确认、冲突处理、长期保留与遗忘。
- **后台查询**支持一次性与周期任务、外部触发和结果通知。后台查询运行期间可以继续对话。配置 Tavily 后可查询公开网页并附来源。

## 快速启动

在仓库根目录运行以下命令。需要 Docker Compose v2 和 Node.js 24。只有 Docker 的环境可参阅[部署说明](docs/DEPLOYMENT.md)。

```sh
node scripts/setup.mjs
```

脚本从 [`.env.example`](.env.example) 生成私有 `.env`，并随机生成数据库密码和 Cookie 签名密钥。在本机的 `.env` 中填写以下配置。

| 配置 | 用途 |
| --- | --- |
| `GMI_API_KEY` | 对话、业务工具决策、录音分析和后台查询 |
| `OPENAI_API_KEY` | 音频转写和向量索引 |
| `TAVILY_API_KEY` | 可选，搜索和读取公开网页 |

```sh
docker compose up -d --build
docker compose ps
```

打开 [http://localhost:8088](http://localhost:8088) 注册账号。部署到公网时请配置 HTTPS，以便浏览器使用麦克风。默认订阅为演示模式。

## 技术架构

| 层 | 实现 |
| --- | --- |
| Web | React、TypeScript、Vite。通过 SSE 同步进度，IndexedDB 暂存离线录音。 |
| API | Fastify 提供身份认证、文件上传、业务接口和事件流。 |
| 数据 | PostgreSQL 17 存储业务记录、操作回执与队列，pgvector 支持语义检索。音频和 Pi 会话保存在独立数据卷。 |
| 执行 | pg-boss 调度主 Agent、后台任务和文件 Worker。Pi SDK 管理每个账号的持续会话。 |
| 模型 | GMI Cloud 运行语言模型。OpenAI 提供转写和 Embedding，Tavily 提供可选的网页检索。 |

录音与后台查询由独立 Worker 处理。录音完成转写和分析后，按窗口合并交给主 Agent，向量索引异步建立。后台查询将持久化的结果交给主 Agent 汇报。主 Agent 按账号串行执行，工具通过服务端权限校验后写入日程、待办和提醒。详见[架构与数据流](docs/ARCHITECTURE.md)。

自托管实例管理账号、音频、会话和业务数据。启用相应功能时，服务端会向所配置的供应商发送处理所需的音频、文本或查询。实例密钥保存在服务端配置中。

## 开发与测试

本地开发需要 Node.js 24、pnpm 10、Docker Compose v2，以及可执行的 `ffmpeg` 和 `ffprobe`。生成 `.env` 后，在仓库根目录运行以下命令。

```sh
pnpm install --frozen-lockfile
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
pnpm db:migrate
pnpm dev
```

开发界面位于 [http://localhost:5179](http://localhost:5179)。如果从完整 Compose 环境切换到本地开发，先按[开发说明](docs/DEPLOYMENT.md#本地开发)停止容器中的应用进程。

- `pnpm test` 运行单元测试。
- `pnpm check` 运行类型检查、单元测试、PostgreSQL 集成测试和构建。
- `pnpm exec playwright install chromium` 安装浏览器后，可用 `pnpm test:e2e` 测试运行中的实例。
- 带 `:live` 的脚本用于验证实际供应商，执行时会产生 API 用量。

## 文档

- [部署、配置与备份](docs/DEPLOYMENT.md)
- [架构与数据流](docs/ARCHITECTURE.md)
- [语音流水线](docs/RECORDING_PIPELINE.md) · [长期记忆](docs/MEMORY.md)
- [日程与待办](docs/AGENDA.md) · [后台任务](docs/BACKGROUND_TASKS.md) · [通知](docs/NOTIFICATIONS.md)
- [界面设计](DESIGN.md) · [对话与阅读进度](docs/CONVERSATION.md)

## 许可证

项目许可证待维护者确认。内置 Manrope 字体采用 [SIL Open Font License 1.1](src/web/public/fonts/OFL.txt)。
