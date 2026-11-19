/** Native Pi/GMI conversation acceptance, isolated database and synthetic quotations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { MemoryService } from '../src/server/memory.js';
import { Runtime } from '../src/server/runtime.js';
import { sourceDocument, saveChunks, evidenceRefs } from '../src/server/sources.js';
const f = await testDatabase(),
  actual = loadConfig(),
  config = {
    ...f.config,
    GMI_API_KEY: actual.GMI_API_KEY,
    GMI_BASE_URL: actual.GMI_BASE_URL,
    GMI_MODEL: actual.GMI_MODEL,
    EMBEDDING_ENABLED: false,
    MAX_RUN_SECONDS: 180,
  },
  runtime = new Runtime(f.db, config),
  memory = new MemoryService(),
  report: any = { at: new Date().toISOString(), checks: [], complete: false };
const { db } = f;
async function check(name: string, fn: () => Promise<any>) {
  const start = Date.now();
  try {
    const details = await fn();
    report.checks.push({ name, ok: true, ms: Date.now() - start, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      ms: Date.now() - start,
      error: safeError(error, config),
    });
    console.error(`FAIL ${name}: ${safeError(error, config)}`);
    process.exitCode = 1;
  }
}
try {
  assert(config.GMI_API_KEY, 'GMI_API_KEY required');
  const u = await f.user();
  for (const [text, value, when] of [
    ['青禾项目报价8.6万元。', '8.6万元', '2026-11-01T08:00:00Z'],
    ['青禾项目现在改为9万元，之前报价作废。', '9万元', '2026-11-10T08:00:00Z'],
  ]) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,$5)",
      [id, u.id, text, randomUUID(), when],
    );
    const source = await sourceDocument(db, u.id, 'message', id),
      chunks = await saveChunks(db, u.id, source);
    await db.tx((c) =>
      memory.remember(c, u.id, source, {
        subject: '青禾项目',
        predicate: '报价',
        value,
        source_refs: evidenceRefs(source, chunks, text),
      }),
    );
  }
  const ask = async (text: string, userId = u.id, allowWaiting = false) => {
    const op = await runtime.ops.submit(userId, randomUUID(), text);
    await runtime.processUser(userId);
    const row = (await db.query('SELECT * FROM operations WHERE id=$1', [op.id])).rows[0];
    assert(
      allowWaiting ? ['succeeded', 'waiting'].includes(row.status) : row.status === 'succeeded',
      row.last_error ?? row.reply,
    );
    const tools = (
      await db.query(
        'SELECT name,input,status,result,error FROM tool_calls WHERE operation_id=$1 ORDER BY started_at',
        [op.id],
      )
    ).rows;
    return { reply: row.reply, status: row.status, memory_summary: row.memory_summary, tools };
  };
  await check(
    'An ordinary greeting uses no extraction/review calls and writes no memory',
    async () => {
      const who = await f.user();
      const result = await ask('你好，今天先随便聊聊。', who.id);
      assert(!result.tools.some((t) => ['prepare_memory', 'remember_fact'].includes(t.name)));
      assert.equal((await memory.list(db, who.id)).length, 0);
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM memory_model_runs WHERE user_id=$1', [
            who.id,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(result.memory_summary.status, 'not_requested');
      return result;
    },
  );
  await check(
    'The conversational Agent actively stores a generic preference without a remember command',
    async () => {
      const who = await f.user();
      const result = await ask('我平时写程序长期使用Linux，这是我最习惯的开发环境。', who.id);
      const facts = await memory.list(db, who.id);
      assert(facts.some((x) => /Linux/i.test(x.value)));
      assert(
        result.tools.some((t) => t.name === 'prepare_memory') &&
          result.tools.some((t) => t.name === 'remember_fact' && t.result?.fact),
      );
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM memory_model_runs WHERE user_id=$1', [
            who.id,
          ])
        ).rows[0].n,
        0,
      );
      return { ...result, facts };
    },
  );
  await check(
    'A clear responsibility is saved even when a same-turn appointment still needs clarification',
    async () => {
      const who = await f.user();
      const result = await ask(
        '陈总是LOL项目的负责人。下周找一天我和他碰个面，具体星期几和几点还没定。',
        who.id,
        true,
      );
      const facts = await memory.list(db, who.id);
      assert(
        facts.some((x) => /陈总/.test(x.subject + x.value) && /LOL/.test(x.subject + x.value)),
      );
      assert(result.tools.some((t) => t.name === 'remember_fact' && t.result?.fact));
      assert(!facts.some((x) => /提醒事项|星期几|几点/.test(x.subject + x.value)));
      return { ...result, facts };
    },
  );
  await check(
    'The conversational Agent schedules a reminder without creating time or duration facts',
    async () => {
      const who = await f.user();
      const result = await ask(
        '请安排2031年3月14日19点到21点和陈总吃饭，并提前30分钟提醒我，时区上海。',
        who.id,
        true,
      );
      assert.equal((await memory.list(db, who.id)).length, 0);
      assert(
        result.tools.some((t) =>
          ['create_event', 'create_arrangement', 'ask_user'].includes(t.name),
        ),
      );
      return result;
    },
  );
  await check(
    'The conversational Agent preserves an unconfirmed condition separately from a lasting goal',
    async () => {
      const who = await f.user();
      const result = await ask(
        '远山活动的场地对方提出费用三十万元，我们还没有确认；我希望整体预算控制在二十五万元。',
        who.id,
      );
      const facts = await memory.list(db, who.id);
      assert(
        facts.some(
          (x) =>
            /三十|30/.test(x.value) &&
            x.certainty === 'tentative' &&
            /未|没有|还没/.test(x.qualifiers),
        ),
      );
      assert(facts.some((x) => /二十五|25/.test(x.value) && x.certainty === 'goal'));
      return { ...result, facts };
    },
  );
  await check(
    'Native Agent retrieves the current quotation and does not answer with the old value',
    async () => {
      const result = await ask(
        '请查询我的记忆，青禾项目现在有效的报价是多少？使用当前记忆模式并给出出处，简短回答。',
      );
      assert.match(result.reply, /9\s*万|九万/);
      assert(result.tools.some((t) => t.name === 'search_history'));
      return result;
    },
  );
  await check(
    'The same persistent Agent retrieves the earlier quotation with historical mode',
    async () => {
      const result = await ask(
        '请查历史或变化过程：2026年11月1日记录的青禾项目报价是多少？请给出当时的金额与出处。',
      );
      assert.match(result.reply, /8\.6|八点六/);
      assert(
        result.tools.some(
          (t) => t.name === 'search_history' && ['history', 'timeline'].includes(t.input.mode),
        ),
      );
      return result;
    },
  );
  await check(
    'An explicit forgetting request invokes memory tools and clears every quotation version',
    async () => {
      const result = await ask(
        '请忘记青禾项目的所有报价记忆，包括以前和现在的版本。先查询历史找到全部记录，再逐条执行忘记；原始对话存档可以保留。',
      );
      assert(result.tools.some((t) => t.name === 'forget_memory'));
      assert.equal((await memory.list(db, u.id, { query: '青禾', mode: 'history' })).length, 0);
      assert.equal(
        (await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [u.id])).rows[0]
          .session_path,
        null,
      );
      return result;
    },
  );
  await check(
    'A fresh active context cannot recover forgotten values through history or prior SDK messages',
    async () => {
      const result = await ask(
        '请检索我的记忆：青禾项目的报价是多少？没有依据就明确说没有找到，不要猜。',
      );
      assert.doesNotMatch(result.reply, /(?:9|九)\s*万元|8\.6|八点六/);
      assert.match(result.reply, /未找到|没有|无法|已忘记|无依据|无可用/);
      assert(result.tools.some((t) => t.name === 'search_history'));
      return result;
    },
  );
  report.complete = report.checks.every((x: any) => x.ok);
} catch (error) {
  report.error = safeError(error, config);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await runtime.stop();
  await f.close();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/memory-conversation-live.json', JSON.stringify(report, null, 2));
  await writeFile(
    `test-results/memory-conversation-live-${report.at.replace(/[:.]/g, '-')}.json`,
    JSON.stringify(report, null, 2),
  );
}
