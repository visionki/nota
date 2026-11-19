# Nota

[Try Nota online](https://nota.claptrap.chat) · [简体中文](README.zh-CN.md)

Nota is a self-hostable voice notebook and AI assistant. Record a thought or ask for something in chat. Nota keeps the transcript and its sources, turns clear requests into tasks or calendar events, and makes details searchable across later conversations.

**Model inference is powered by GMI Cloud Inference Engine** for chat, voice note analysis, and background queries. [GMI Cloud developer docs](https://www.gmicloud.ai/en/developers)

## Features

- **Voice notes.** Record in the browser, upload audio, or save a recording offline until you reconnect. Edit a transcript and revisit previous versions.
- **Continuous chat.** Each account has a persistent conversation. Add a follow-up while a request is running and review the actual tool receipts afterward.
- **Calendar, tasks, and reminders.** Set planning dates, deadlines, and reminder times separately. Browse month or week views and export to ICS.
- **Source-linked memory.** Review supporting excerpts, resolve ambiguous identities, and update or forget facts.
- **Background queries.** Schedule a one-off or recurring query, or start it with a webhook. Results return to chat while you keep working. Optional Tavily integration adds public web lookup.
- **English and Simplified Chinese.** Nota follows the browser's language and region by default. Choose a language on the sign-in page or in Settings.

The hosted demo gives each account **10 new AI requests per day**, reset at midnight in Beijing. The allowance is shared across that account's sessions. Pro is in development.

## Quick start

Install Docker Compose v2 and Node.js 24. Clone this repository and generate your local configuration.

```sh
git clone https://github.com/visionki/nota.git
cd nota
node scripts/setup.mjs
```

The setup script creates an ignored `.env` from [`.env.example`](.env.example) and generates a database password and cookie signing secret. Add your provider keys to that local file.

| Key              | Used for                                                    |
| ---------------- | ----------------------------------------------------------- |
| `GMI_API_KEY`    | Chat, tool decisions, note analysis, and background queries |
| `OPENAI_API_KEY` | Audio transcription and embeddings                          |
| `TAVILY_API_KEY` | Optional web search and page extraction                     |

```sh
docker compose up -d --build
docker compose ps
```

Open [http://localhost:8088](http://localhost:8088) and create an account. Use HTTPS for microphone access on a public instance. The [deployment guide](docs/DEPLOYMENT.md) covers Docker-only setup, HTTPS, server configuration, and backups.

## Architecture

| Layer   | Implementation                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Web     | React, TypeScript, and Vite. Server-sent events stream progress. IndexedDB holds queued recordings offline.                                     |
| API     | Fastify handles authentication, uploads, calendar operations, and event streams.                                                                |
| Data    | PostgreSQL 17 stores records, job state, and receipts. pgvector supports semantic search. Audio and Pi session files live on a separate volume. |
| Workers | pg-boss queues work for the main agent, background tasks, and recording processing. Pi SDK maintains each account's ongoing conversation.       |

The separation between a persistent conversation and isolated workers takes inspiration from [DeepSeek's SuperAgent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). In Nota, recording workers save transcripts and analyses, then hand off a completed batch to the main agent. Scheduled queries run in separate Pi sessions and deliver persisted results back to chat. Account-scoped tools write calendar events, tasks, and reminders, and save receipts for those writes. [Architecture and data flow](docs/ARCHITECTURE.md)

The self-hosted instance holds account data, recordings, and conversations. When a feature is enabled, the server sends the audio, text, or query needed for the operation to its configured provider. API keys stay in server configuration.

## Development and tests

Local development requires Node.js 24, pnpm 10, Docker Compose v2, and `ffmpeg` and `ffprobe`. After running the setup script, start the database and dev processes.

```sh
pnpm install --frozen-lockfile
docker compose -f compose.yaml -f compose.dev.yaml up -d postgres
pnpm db:migrate
pnpm dev
```

Open [http://localhost:5179](http://localhost:5179). Follow the [development guide](docs/DEPLOYMENT.md#本地开发) when switching from the full Compose stack to local processes.

- `pnpm test` runs unit tests.
- `pnpm check` runs the type check, tests against PostgreSQL, and the build.
- `pnpm exec playwright install chromium` installs the browser for `pnpm test:e2e`.
- Scripts with a `:live` suffix call live providers and use API credits.

## Documentation

- [Deployment, configuration, and backups](docs/DEPLOYMENT.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Recording pipeline](docs/RECORDING_PIPELINE.md) · [Long-term memory](docs/MEMORY.md)
- [Calendar and tasks](docs/AGENDA.md) · [Background tasks](docs/BACKGROUND_TASKS.md) · [Notifications](docs/NOTIFICATIONS.md)
- [Interface design](DESIGN.md) · [Conversation and reading position](docs/CONVERSATION.md)

## License

The project license is pending. The bundled Manrope font uses the [SIL Open Font License 1.1](src/web/public/fonts/OFL.txt).
