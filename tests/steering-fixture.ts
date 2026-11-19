/** Real Pi SDK and business tools, driven by a local OpenAI-compatible streaming provider. */
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { Runtime } from '../src/server/runtime.js';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
export async function nativeSteeringFixture(
  scenario: 'correction' | 'clarification' | 'event_edit' = 'correction',
) {
  const fixture = await testDatabase(),
    { db } = fixture;
  const first = gate(),
    releaseFirst = gate(),
    afterCreate = gate(),
    releaseAfterCreate = gate();
  const title = `${scenario === 'event_edit' ? '面谈' : '叫我起床'}-${randomUUID().slice(0, 6)}`;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + 2 * 864e5));
  const at = (hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  const requests: any[] = [];
  const providerErrors: string[] = [];
  function chunk(res: ServerResponse, delta: unknown, finish_reason: string | null = null) {
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'controlled-' + requests.length,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'controlled-steering',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  }
  function finish(res: ServerResponse, tool?: { name: string; arguments: unknown }) {
    if (tool)
      chunk(res, {
        tool_calls: [
          {
            index: 0,
            id: 'call-' + requests.length,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      });
    chunk(res, {}, tool ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  }
  const upstream = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const payload = JSON.parse(raw);
      requests.push(payload);
      const n = requests.length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (scenario === 'event_edit') {
        const schema = payload.tools.find((tool: any) => tool.function.name === 'update_event')
          ?.function.parameters;
        for (const name of ['location', 'notes', 'timezone', 'person_id', 'recording_id'])
          if (!schema?.properties?.[name])
            throw new Error(`Missing event patch parameter: ${name}`);
        const event = (await db.query('SELECT id FROM calendar_events WHERE title=$1', [title]))
          .rows[0];
        if (!event) throw new Error('Original event missing');
        chunk(res, { role: 'assistant', content: '我会找到原日程，只修改地点。' });
        if (n === 1) finish(res, { name: 'get_agenda', arguments: { from: at(0), to: at(23) } });
        else if (n === 2) {
          if (
            !JSON.stringify(
              payload.messages.filter((message: any) => message.role === 'tool'),
            ).includes(event.id)
          )
            throw new Error('Event not discovered through calendar');
          finish(res, { name: 'get_event', arguments: { event_id: event.id } });
        } else if (n === 3)
          finish(res, {
            name: 'update_event',
            arguments: { event_id: event.id, location: '科苑地铁站附近' },
          });
        else if (n === 4) finish(res, { name: 'get_event', arguments: { event_id: event.id } });
        else {
          const latest = payload.messages.filter((message: any) => message.role === 'tool').at(-1);
          if (!JSON.stringify(latest?.content).includes('科苑地铁站附近'))
            throw new Error('Event reread is stale');
          finish(res);
        }
      } else if (scenario === 'correction') {
        if (n === 1) {
          chunk(res, { role: 'assistant', content: '好的，我来设置后天上午3点的提醒。' });
          first.open();
          await releaseFirst.wait;
          finish(res, { name: 'create_reminder', arguments: { title, remind_at: at(3) } });
        } else if (n === 2) {
          chunk(res, {
            role: 'assistant',
            content: '收到补充，旧的3点参数未执行，现在设置上午6点。',
          });
          finish(res, { name: 'create_reminder', arguments: { title, remind_at: at(6) } });
        } else if (n === 3) {
          chunk(res, { role: 'assistant', content: '上午6点的提醒已经创建。' });
          afterCreate.open();
          await releaseAfterCreate.wait;
          finish(res);
        } else if (n === 4) {
          const reminder = (await db.query('SELECT id FROM reminders WHERE title=$1', [title]))
            .rows[0];
          if (!reminder) throw new Error('Completed reminder missing');
          chunk(res, {
            role: 'assistant',
            content: '6点的提醒已经存在，我修改原来的这一条，保留已执行的事实。',
          });
          finish(res, {
            name: 'update_reminder',
            arguments: { reminder_id: reminder.id, remind_at: at(7) },
          });
        } else {
          chunk(res, {
            role: 'assistant',
            content: `已将同一条提醒改为 ${day} 上午7点，原来的6点创建记录保留。`,
          });
          finish(res);
        }
      } else {
        if (n === 1) {
          chunk(res, { role: 'assistant', content: '我需要确认3点的时段。' });
          finish(res, { name: 'ask_user', arguments: { question: '你说的3点是凌晨还是下午？' } });
        } else if (n === 2) {
          chunk(res, { role: 'assistant', content: '请确认是凌晨3点还是下午3点。' });
          first.open();
          await releaseFirst.wait;
          finish(res);
        } else if (n === 3) {
          chunk(res, {
            role: 'assistant',
            content: '收到更正，使用上午6点，不再等待旧的3点确认。',
          });
          finish(res, { name: 'create_reminder', arguments: { title, remind_at: at(6) } });
        } else {
          chunk(res, { role: 'assistant', content: `已设置 ${day} 上午6点的提醒。` });
          finish(res);
        }
      }
    } catch (error) {
      providerErrors.push(String(error));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Controlled provider failed' } }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as { port: number };
  const config = {
    ...fixture.config,
    GMI_API_KEY: 'controlled-steering-key',
    GMI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    GMI_MODEL: 'controlled-steering',
    MAX_RUN_SECONDS: 45,
    LLM_REQUEST_IDLE_MS: 15000,
  };
  const runtime = new Runtime(db, config);
  await runtime.queue.start();
  const service = await createApp(config, db),
    { app } = service;
  const runs = new Set<Promise<void>>();
  app.addHook('onResponse', async (req) => {
    if (req.method === 'POST' && req.url === '/api/chat' && req.user) {
      const job = runtime.processUser(req.user.id);
      runs.add(job);
      void job.finally(() => runs.delete(job)).catch(() => {});
    }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  config.APP_URL = base;
  return {
    ...fixture,
    ...service,
    runtime,
    base,
    title,
    day,
    at,
    requests,
    providerErrors,
    first,
    releaseFirst,
    afterCreate,
    releaseAfterCreate,
    async close() {
      releaseFirst.open();
      releaseAfterCreate.open();
      await runtime.stop();
      upstream.closeAllConnections();
      await Promise.allSettled([...runs]);
      await app.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await fixture.close();
    },
  };
}
