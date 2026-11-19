/** Native Pi SDK + real HTTP/SSE/tools; gated ASR and a local streaming model. */
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { Runtime } from '../src/server/runtime.js';
import { dispatchWindows } from '../src/server/recording-windows.js';
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
export async function recordingFixture(options: { candidateKind?: 'todo' | 'event' } = {}) {
  const fixture = await testDatabase(),
    { db } = fixture,
    started = gate(),
    release = gate(),
    requests: any[] = [],
    errors: string[] = [];
  const marker =
    '这段无关细节只保存在文件原文，不能自动注入主会话。'.repeat(80) +
    '唯一原文标记-RAW-ONLY-938427';
  const text = `陈总确认青禾项目报价8.6万元。请给我创建核对附件的待办，无需截止时间。\n${marker}`;
  const content = (value: any) =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('')
        : '';
  function chunk(res: ServerResponse, delta: any, finish_reason: string | null = null) {
    res.write(
      'data: ' +
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'controlled-recording',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  }
  const upstream = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const envelopes = body.messages
        .filter((m: any) => m.role === 'user')
        .flatMap((m: any) => {
          try {
            return [JSON.parse(content(m.content))];
          } catch {
            return [];
          }
        });
      const current = envelopes.at(-1);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      let tool: any;
      if (current?.recording_batch) {
        const items = current.recording_batch.items;
        const action = items
          .flatMap((x: any) => x.actions)
          .find(
            (x: any) =>
              x.payload.actor === 'self' &&
              x.payload.explicit &&
              x.payload.execution_allowed !== false,
          );
        const candidate = (
          await db.query('SELECT result_id FROM candidate_actions WHERE id=$1', [
            action.candidate_id,
          ])
        ).rows[0];
        const sourceRead = (
          await db.query(
            "SELECT 1 FROM tool_calls WHERE operation_id=$1 AND name='read_source' AND status='succeeded'",
            [current.event.operation_id],
          )
        ).rows.length;
        if (!candidate.result_id) {
          chunk(res, {
            role: 'assistant',
            content: '录音已经独立整理完成，我来执行明确交办，并核对来源。',
          });
          tool = {
            name: 'create_todo',
            arguments: { title: '核对附件', candidate_id: action.candidate_id },
          };
        } else if (!sourceRead) {
          chunk(res, { role: 'assistant', content: '待办已经创建，现在核对来源附近的原文。' });
          tool = {
            name: 'read_source',
            arguments: { chunk_id: action.source_refs[0].chunk_id, before: 0, after: 0 },
          };
        } else
          chunk(res, {
            role: 'assistant',
            content: `这 ${items.length} 条便签已统一整理，已创建一项核对附件的待办。[查看原文出处](${action.source_refs[0].source_url})`,
          });
      } else
        chunk(res, {
          role: 'assistant',
          content: '可以，录音在独立整理，我现在就能回应你的聊天。',
        });
      if (tool)
        chunk(res, {
          tool_calls: [
            {
              index: 0,
              id: randomUUID(),
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        });
      chunk(res, {}, tool ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    } catch (e) {
      errors.push(String(e));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const config = {
    ...fixture.config,
    GMI_API_KEY: 'controlled-recording',
    GMI_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    GMI_MODEL: 'controlled-recording',
    EMBEDDING_ENABLED: false,
    MAX_RUN_SECONDS: 45,
    RECORDING_WINDOW_IDLE_MS: 100,
  };
  const runtime = new Runtime(db, config);
  runtime.files.reviewer.decide = async (_u, proposals) =>
    proposals.map(() => ({
      action: 'ADD',
      target_ids: [],
      classification: 'durable',
      evidence_supported: true,
      reason: 'Controlled recording fixture',
    }));
  await runtime.queue.start();
  runtime.files.transcriber.transcribe = async () => {
    started.open();
    await release.wait;
    return { text, segments: [], model: 'controlled-asr' };
  };
  runtime.files.analyzer.analyze = async () => ({
    summary: '青禾项目报价8.6万元，用户交办核对附件。',
    facts: [
      {
        subject: '青禾项目',
        predicate: '报价',
        value: '8.6万元',
        evidence: '陈总确认青禾项目报价8.6万元',
        person_name: '陈总',
      },
    ],
    actions: [
      {
        kind: options.candidateKind ?? 'todo',
        title: '核对附件',
        actor: 'self',
        explicit: true,
        evidence: '请给我创建核对附件的待办，无需截止时间',
      },
    ],
    uncertainties: [],
  });
  const service = await createApp(config, db),
    { app } = service,
    runs = new Set<Promise<void>>();
  let owner = '';
  const track = (run: Promise<void>) => {
    runs.add(run);
    void run.finally(() => runs.delete(run)).catch(() => {});
  };
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || !req.user || reply.statusCode >= 400) return;
    owner = req.user.id;
    if (req.url === '/api/recordings')
      for (const op of (
        await db.query(
          "SELECT id FROM operations WHERE user_id=$1 AND executor='recording' AND status='queued'",
          [owner],
        )
      ).rows)
        track(runtime.files.process(op.id));
    if (req.url === '/api/chat') track(runtime.processUser(owner));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  config.APP_URL = base;
  return {
    ...fixture,
    base,
    db,
    runtime,
    started,
    release,
    requests,
    errors,
    text,
    async flush() {
      release.open();
      await Promise.all([...runs]);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE user_id=$1",
        [owner],
      );
      await dispatchWindows(db, 100);
      track(runtime.processUser(owner));
    },
    async close() {
      release.open();
      await Promise.allSettled([...runs]);
      await runtime.stop();
      await app.close();
      await new Promise<void>((r) => {
        upstream.close(() => r());
        upstream.closeAllConnections();
      });
      await fixture.close();
    },
  };
}
