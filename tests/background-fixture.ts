/** Real Pi sessions, tools, PostgreSQL and HTTP; only provider responses are controlled. */
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { Runtime } from '../src/server/runtime.js';
import { Tavily } from '../src/server/tavily.js';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
function textOf(content: any): string {
  return typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('');
}

export async function backgroundFixture(autoStart = false) {
  const f = await testDatabase();
  const requests: { task: boolean; report: boolean; payload: any }[] = [];
  const errors: string[] = [];
  const blocks = new Map<
    string,
    { started: ReturnType<typeof gate>; release: ReturnType<typeof gate> }
  >();
  const releases = new Set<() => void>();
  const hold = (key: string) => {
    const block = { started: gate(), release: gate() };
    blocks.set(key, block);
    releases.add(block.release.open);
    return block;
  };
  const chunk = (res: ServerResponse, delta: object, reason: string | null = null) => {
    if (res.destroyed) return;
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'controlled-background',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'controlled-background',
          choices: [{ index: 0, delta, finish_reason: reason }],
        }) +
        '\n\n',
    );
  };
  const upstream = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const payload = JSON.parse(raw);
      const task = textOf(payload.messages[0].content).includes('后台任务执行助手');
      const envelope = JSON.parse(
        textOf(payload.messages.filter((message: any) => message.role === 'user').at(-1).content),
      );
      const report = !!envelope.background_result;
      requests.push({ task, report, payload });
      if (Array.isArray(payload.tools) && payload.tools.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'tools array cannot be empty; omit the field entirely' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunk(res, { role: 'assistant' });
      const key = `${task ? 'task' : report ? 'report' : 'chat'}:${report ? envelope.background_result.request : envelope.user_request}`;
      const block = blocks.get(key);
      if (block) {
        blocks.delete(key);
        block.started.open();
        await block.release.wait;
      }
      if (res.destroyed) return;
      const searched = payload.messages.some((message: any) => message.role === 'tool');
      const read = payload.messages.some((message: any) =>
        message.tool_calls?.some((call: any) => call.function.name === 'read_webpage'),
      );
      const foregroundTool =
        !task && !report && envelope.user_request === 'tool-history-before-report' && !searched;
      if (foregroundTool || (task && (!searched || !read))) {
        chunk(res, {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: 'function',
              function: {
                name: foregroundTool ? 'get_agenda' : searched ? 'read_webpage' : 'search_web',
                arguments: JSON.stringify(
                  foregroundTool
                    ? { from: '2026-11-13T00:00:00+08:00', to: '2026-11-14T00:00:00+08:00' }
                    : searched
                      ? { url: 'https://example.com/notice' }
                      : { query: '公开公告', limit: 1 },
                ),
              },
            },
          ],
        });
        chunk(res, {}, 'tool_calls');
      } else {
        const content = task
          ? '已核实公告：[官方来源](https://example.com/notice)。仍需留意后续调整。'
          : report
            ? `后台任务结果：${envelope.background_result.summary}${envelope.background_result.error ?? ''}`
            : `前台聊天已回复：${envelope.user_request}`;
        chunk(res, { content });
        chunk(res, {}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Controlled background provider failed' } }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const originalSearch = Tavily.prototype.search;
  const originalRead = Tavily.prototype.read;
  Tavily.prototype.search = async function (input: any, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
      provider: 'tavily',
      external_content: true,
      query: input.query,
      retrieved_at: new Date().toISOString(),
      results: [
        {
          title: '官方来源',
          url: 'https://example.com/notice',
          snippet: 'RAW_SEARCH_ONLY: 此内容只在后台研究会话出现。',
          source_date: '2026-11-13',
        },
      ],
    };
  };
  Tavily.prototype.read = async function (input: any, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return {
      provider: 'tavily',
      external_content: true,
      url: input.url,
      retrieved_at: new Date().toISOString(),
      content: 'RAW_SEARCH_ONLY: 官方网页原文。',
      offset: 0,
      total_chars: 30,
      next_offset: null,
    };
  };
  const config = {
    ...f.config,
    GMI_API_KEY: 'controlled-background-key',
    GMI_BASE_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    GMI_MODEL: 'controlled-background',
    MAX_RUN_SECONDS: 30,
    LLM_REQUEST_IDLE_MS: 15000,
  };
  const runtime = new Runtime(f.db, config);
  const { app } = await createApp(config, f.db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  config.APP_URL = base;
  if (autoStart) await runtime.start();
  else await runtime.queue.start();
  return {
    ...f,
    config,
    runtime,
    app,
    base,
    requests,
    errors,
    hold,
    async close() {
      for (const release of releases) release();
      await runtime.stop();
      app.server.closeAllConnections();
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      Tavily.prototype.search = originalSearch;
      Tavily.prototype.read = originalRead;
      await f.close();
    },
  };
}
