/** Real Nota runtime and Pi session recovery; a local provider captures the exact HTTP input. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { testDatabase } from './helpers.js';
import { Runtime } from '../src/server/runtime.js';
import { createApp } from '../src/server/app.js';

const f = await testDatabase(),
  requests: any[] = [],
  errors: string[] = [],
  results: any[] = [];
const upstream = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'context-contract',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'controlled-context',
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    chunk({ role: 'assistant', content: '已收到本条消息。' });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    errors.push(String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const config = {
    ...f.config,
    GMI_API_KEY: 'controlled-local-key',
    GMI_MODEL: 'controlled-context',
    GMI_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    EMBEDDING_ENABLED: false,
  },
  { app } = await createApp(config, f.db);
let runtime = new Runtime(f.db, config);
const body = (payload: any) => JSON.stringify(payload.messages);
const old = ['RAW-ENTRY-1-x7q', 'RAW-ENTRY-2-a8r', 'RAW-ENTRY-3-b9s', 'RAW-ENTRY-4-c1t'];
const kept = ['RECENT-ENTRY-5-d2u', 'RECENT-ENTRY-6-e3v'];
const firstSummary = 'SUMMARY-ENTRIES-ONE-THROUGH-FOUR';
const secondSummary = 'SUMMARY-ENTRIES-ONE-THROUGH-SIX';
async function check(name: string, run: () => Promise<any>) {
  const details = await run();
  results.push({ name, ok: true, details });
  console.log(`PASS ${name}`);
}
function assistant(text: string): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'nota-gmi',
    model: config.GMI_MODEL,
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
try {
  const u = await f.user(),
    dir = resolve(config.DATA_DIR, 'sessions', u.id);
  await mkdir(dir, { recursive: true });
  const manager = SessionManager.create(dir, dir),
    ids: string[] = [];
  [...old, ...kept].forEach((text, index) => {
    ids.push(
      manager.appendMessage(
        index % 2
          ? assistant(text)
          : { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
      ),
    );
  });
  // Fix the boundary independently of token heuristics: 1–4 summarized, 5–6 retained.
  const firstId = manager.appendCompaction(firstSummary, ids[4], 300);
  const sessionFile = manager.getSessionFile()!;
  await f.db.query('UPDATE bot_state SET session_path=$2 WHERE user_id=$1', [
    u.id,
    relative(resolve(config.DATA_DIR), sessionFile).replaceAll('\\', '/'),
  ]);
  const ask = async (text: string) => {
    const before = requests.length;
    const operation = await runtime.ops.submit(u.id, randomUUID(), text);
    await runtime.processUser(u.id);
    const row = (
      await f.db.query('SELECT status,last_error FROM operations WHERE id=$1', [operation.id])
    ).rows[0];
    assert.equal(row.status, 'succeeded', row.last_error);
    assert.equal(requests.length, before + 1);
    return requests.at(-1);
  };
  await check(
    'Request 7 contains the summary plus 5, 6, 7 while the complete history remains readable',
    async () => {
      const payload = await ask('NEW-ENTRY-7-f4w'),
        text = body(payload);
      for (const marker of [firstSummary, ...kept, 'NEW-ENTRY-7-f4w'])
        assert(text.includes(marker), marker);
      for (const marker of old) assert(!text.includes(marker), marker);
      assert(text.indexOf(firstSummary) < text.indexOf(kept[0]));
      assert(text.indexOf(kept[0]) < text.indexOf(kept[1]));
      assert(text.indexOf(kept[1]) < text.indexOf('NEW-ENTRY-7-f4w'));
      const cookie = `nota_session=${encodeURIComponent(app.signCookie(await f.auth.session(u.id)))}`;
      const history = await app.inject({
        method: 'GET',
        url: '/api/context/history',
        headers: { cookie },
      });
      assert.equal(history.statusCode, 200);
      for (const marker of [...old, ...kept, firstSummary])
        assert(history.body.includes(marker), marker);
      return {
        visible_markers: [firstSummary, ...kept, 'NEW-ENTRY-7-f4w'],
        old_raw_sent: false,
        full_history_preserved: true,
      };
    },
  );
  await check(
    'A new Runtime restores the same compacted context without reintroducing old raw messages',
    async () => {
      await runtime.stop();
      runtime = new Runtime(f.db, config);
      const text = body(await ask('NEW-ENTRY-8-g5x'));
      for (const marker of [firstSummary, ...kept, 'NEW-ENTRY-7-f4w', 'NEW-ENTRY-8-g5x'])
        assert(text.includes(marker), marker);
      for (const marker of old) assert(!text.includes(marker), marker);
      return { compacted_session_restored: true, old_raw_sent: false };
    },
  );
  await check(
    'A second compaction uses only the latest summary and retained tail, keeping both checkpoints in the archive',
    async () => {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      const seven = reopened
        .getEntries()
        .find(
          (e: any) =>
            e.type === 'message' && JSON.stringify(e.message.content).includes('NEW-ENTRY-7-f4w'),
        );
      assert(seven);
      const secondId = reopened.appendCompaction(secondSummary, seven.id, 250);
      const text = body(await ask('NEW-ENTRY-9-h6y'));
      for (const marker of [secondSummary, 'NEW-ENTRY-7-f4w', 'NEW-ENTRY-8-g5x', 'NEW-ENTRY-9-h6y'])
        assert(text.includes(marker), marker);
      for (const marker of [...old, ...kept, firstSummary]) assert(!text.includes(marker), marker);
      const archive = await readFile(sessionFile, 'utf8');
      for (const marker of [...old, ...kept, firstSummary, secondSummary, firstId, secondId])
        assert(archive.includes(marker), marker);
      assert.deepEqual(errors, []);
      return {
        latest_summary_only: true,
        both_checkpoints_preserved: true,
        first_compaction: firstId,
        second_compaction: secondId,
      };
    },
  );
} catch (error) {
  results.push({ name: 'context acceptance', ok: false, error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await runtime.stop();
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>((done) => upstream.close(() => done()));
  await f.close();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/context-integration.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        scope:
          'Real Pi SDK and Nota Runtime with seeded compaction boundaries; local controlled provider, not a long-context model-quality benchmark.',
        results,
        requests,
      },
      null,
      2,
    ),
  );
}
