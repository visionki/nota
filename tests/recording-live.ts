/** Opt-in real OpenAI ASR/embeddings and GMI analysis + native Pi Agent acceptance. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { Runtime } from '../src/server/runtime.js';
import { dispatchWindows } from '../src/server/recording-windows.js';
const actual = loadConfig(),
  fixture = await testDatabase(),
  { db } = fixture;
const config = {
  ...fixture.config,
  GMI_API_KEY: actual.GMI_API_KEY,
  OPENAI_API_KEY: actual.OPENAI_API_KEY,
  GMI_BASE_URL: actual.GMI_BASE_URL,
  OPENAI_BASE_URL: actual.OPENAI_BASE_URL,
  MAX_RUN_SECONDS: 480,
};
const runtime = new Runtime(db, config),
  { app } = await createApp(config, db),
  report: any = { at: new Date().toISOString(), checks: [], complete: false };
let release!: () => void;
const gated = new Promise<void>((r) => (release = r));
let firstStarted!: () => void;
const firstGate = new Promise<void>((r) => (firstStarted = r));
let firstRecording = '';
const original = runtime.files.analyzer.analyze.bind(runtime.files.analyzer);
runtime.files.analyzer.analyze = async (source, ...args) => {
  if (source.id === firstRecording) {
    firstStarted();
    await gated;
  }
  return original(source, ...args);
};
async function check(name: string, fn: () => Promise<any>) {
  const at = Date.now();
  const details = await fn();
  report.checks.push({ name, ok: true, ms: Date.now() - at, details });
  console.log(`PASS ${name}`);
}
try {
  assert(config.OPENAI_API_KEY && config.GMI_API_KEY, 'Real provider keys required');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  config.APP_URL = base;
  const login = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `pipeline-live-${randomUUID()}@nota.local`,
      password: randomUUID(),
      name: '真实录音流水线验收',
    }),
  });
  assert(login.ok);
  const cookie = login.headers.get('set-cookie')!.split(';')[0],
    user = ((await login.json()) as any).user;
  async function call(path: string, body?: any) {
    const r = await fetch(base + '/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        cookie,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const data: any = await r.json();
    assert(r.ok, `${r.status}: ${data.error}`);
    return data;
  }
  await runtime.start();
  const audio = new Uint8Array(await readFile('tests/fixtures/nota-chinese.wav')),
    day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + 7 * 864e5));
  const upload = async (n: number) => {
    const form = new FormData();
    form.set('idempotency_key', randomUUID());
    form.set('title', `流水线真实录音 ${n}`);
    form.set('recorded_at', new Date(Date.now() - 2 * 864e5).toISOString());
    form.set('recorded_timezone', 'Asia/Shanghai');
    form.set(
      'instruction',
      n === 1
        ? `请整理并执行明确交办。验收录音中的待办截止日和评审日统一改为${day}，北京时间，具体时刻与提前一天提醒保持原样。`
        : '仅摘要，不提取人物记忆，不创建任何日程、待办或提醒。',
    );
    form.set('file', new Blob([audio], { type: 'audio/wav' }), `memo-${n}.wav`);
    return call('/recordings', form);
  };
  const files: any[] = [];
  await check(
    'Real audio enters file preparation while ordinary chat remains independent',
    async () => {
      files.push(await upload(1));
      firstRecording = files[0].id;
      await Promise.race([
        firstGate,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('First analysis did not start')), 90000),
        ),
      ]);
      const chat = await call('/chat', {
        text: '录音正在整理，请只回复“可以继续聊天”，不用查询和调用工具。',
        idempotency_key: randomUUID(),
      });
      assert.notEqual(chat.id, files[0].operation_id);
      assert.equal(chat.steered, false);
      let done: any;
      for (let i = 0; i < 60; i++) {
        done = await call(`/operations/${chat.id}`);
        if (done.operation.status === 'succeeded') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(done.operation.status, 'succeeded', done.operation.last_error);
      return { independent: true, reply: done.operation.reply };
    },
  );
  await check(
    'Five later real uploads join the in-flight window and generate one native Agent delivery',
    async () => {
      for (let n = 2; n <= 6; n++) files.push(await upload(n));
      assert(files.every((x) => x.batch_id === files[0].batch_id));
      release();
      let batch: any, operation: any;
      const deadline = Date.now() + 360000;
      while (Date.now() < deadline) {
        batch = await call(`/recording-batches/${files[0].batch_id}`);
        if (batch.batch.agent_operation_id) {
          operation = await call(`/operations/${batch.batch.agent_operation_id}`);
          if (['succeeded', 'waiting', 'failed'].includes(operation.operation.status)) break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      assert.equal(
        operation?.operation.status,
        'succeeded',
        JSON.stringify({
          error: operation?.operation.last_error,
          reply: operation?.operation.reply,
          items: batch?.items.map((x: any) => ({ state: x.state, error: x.error })),
        }),
      );
      assert.equal(batch.items.length, 6);
      assert(batch.items.every((x: any) => x.state === 'ready'));
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [user.id])).rowCount,
        1,
      );
      const messages = (await call('/messages')).messages;
      assert.equal(
        messages.filter((m: any) => m.role === 'assistant' && m.kind === 'trigger').length,
        1,
      );
      assert.equal(messages.filter((m: any) => m.kind === 'recording').length, 0);
      const usage = await call('/usage');
      assert.equal(usage.used, 7);
      assert.equal(usage.reserved, 0);
      const todos = (await call('/todos')).todos;
      assert.equal(todos.length, 1);
      const events = (await db.query('SELECT * FROM calendar_events WHERE user_id=$1', [user.id]))
        .rows;
      assert.equal(events.length, 1);
      assert.equal(
        new Date(events[0].starts_at).toISOString(),
        new Date(`${day}T15:00:00+08:00`).toISOString(),
      );
      const reminders = (await db.query('SELECT * FROM reminders WHERE user_id=$1', [user.id]))
        .rows;
      assert.equal(reminders.length, 1);
      assert(
        todos[0].source_refs.length &&
          events[0].source_refs.length &&
          reminders[0].source_refs.length,
      );
      await dispatchWindows(db, 100);
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [user.id])).rowCount,
        1,
      );
      report.batch = files[0].batch_id;
      return {
        files: 6,
        activations: 1,
        quota: usage.used,
        events: events.length,
        todos: todos.length,
        reminders: reminders.length,
        reply: operation.operation.reply,
      };
    },
  );
  await check(
    'Real embeddings support Chinese semantic retrieval with reversible file/version/chunk references',
    async () => {
      const deadline = Date.now() + 90000;
      let indexed = 0;
      while (Date.now() < deadline) {
        indexed = (
          await db.query(
            "SELECT count(DISTINCT c.source_id)::int AS n FROM source_chunks c JOIN chunk_embeddings e ON e.chunk_id=c.id WHERE c.user_id=$1 AND c.source_kind='recording'",
            [user.id],
          )
        ).rows[0].n;
        if (indexed === 6) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.equal(indexed, 6);
      const search = await call(
        '/search?q=' + encodeURIComponent('这次项目谈下来的价钱具体是多少'),
      );
      assert.equal(search.mode, 'hybrid');
      assert(search.chunks.some((x: any) => files.some((f) => f.id === x.source_id)));
      const chunk = search.chunks.find((x: any) => files.some((f) => f.id === x.source_id)),
        source = await call(`/sources/${chunk.id}?before=1&after=1`);
      assert.equal(source.source_version, 1);
      assert(source.chunks.some((x: any) => x.id === chunk.id));
      const path = (
        await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [user.id])
      ).rows[0].session_path;
      const history = await readFile(`${config.DATA_DIR}/${path}`, 'utf8');
      const userEntries = history
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((x: any) => x.message?.role === 'user');
      const batchEntry = userEntries.find((x: any) =>
        JSON.stringify(x.message.content).includes('recording_batch'),
      );
      assert(batchEntry);
      assert(!JSON.stringify(batchEntry).includes('"transcript"'));
      assert(!JSON.stringify(batchEntry).includes('source_text'));
      return {
        indexedRecordings: indexed,
        mode: search.mode,
        sourceVersion: source.source_version,
        defaultContextContainsOnlyArtifacts: true,
      };
    },
  );
  report.complete = true;
} catch (e) {
  report.error = safeError(e, config);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  release();
  await runtime.stop();
  await app.close();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/recording-live.json', JSON.stringify(report, null, 2));
  await fixture.close();
}
