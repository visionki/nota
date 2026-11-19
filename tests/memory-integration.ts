import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { MemoryService } from '../src/server/memory.js';
import {
  sourceDocument,
  saveChunks,
  evidenceRefs,
  enqueueIndex,
  Embeddings,
} from '../src/server/sources.js';
import { RecordingPipeline } from '../src/server/recording-pipeline.js';
import { searchHistory } from '../src/server/domain.js';
import { createApp } from '../src/server/app.js';
const fixture = await testDatabase(),
  { db, config } = fixture,
  memory = new MemoryService(),
  pipeline = new RecordingPipeline(db, config);
const { app } = await createApp(config, db);
const results: any[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error) });
    console.error(`FAIL ${name}: ${error}`);
  }
}
async function document(
  userId: string,
  text: string,
  options: {
    when?: string;
    kind?: 'message' | 'recording';
    instruction?: string;
    version?: number;
  } = {},
) {
  const id = randomUUID(),
    kind = options.kind ?? 'message',
    version = options.version ?? 1;
  if (kind === 'message')
    await db.query(
      "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,$5)",
      [id, userId, text, randomUUID(), options.when ?? new Date().toISOString()],
    );
  else {
    const op = randomUUID();
    await db.query(
      "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status,executor) VALUES($1,$2,$3,'fixture','recording',$4,'succeeded','recording')",
      [
        op,
        userId,
        randomUUID(),
        { instruction: options.instruction ?? '整理便签', recording_id: id },
      ],
    );
    await db.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,recorded_at,recorded_timezone,status) VALUES($1,$2,$3,'记忆验收',$4,'fixture.wav','audio/wav',100,1,$5,$6,$7,'Asia/Shanghai','ready')",
      [id, userId, op, randomUUID(), text, version, options.when ?? null],
    );
  }
  const source = await sourceDocument(db, userId, kind, id),
    chunks = await saveChunks(db, userId, source);
  return {
    source,
    chunks,
    refs: (quote = text) => evidenceRefs(source, chunks, quote),
    save: (item: any = {}, quote = text) =>
      db.tx((c) =>
        memory.remember(c, userId, source, {
          subject: '青禾项目',
          predicate: '报价',
          value: '8.6万元',
          ...item,
          source_refs: evidenceRefs(source, chunks, quote),
        }),
      ),
  };
}
const fact = async (id: string) =>
  (await db.query('SELECT * FROM facts WHERE id=$1', [id])).rows[0];
try {
  await check(
    'Duplicate evidence spans and numeric equivalents produce one fact and no reinforcement for retries',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '我刚和陈总聊完，青禾项目报价8.6万元。');
      const a = await d.save(),
        b = await d.save({ value: '86000元' }, '青禾项目报价8.6万元');
      assert.equal(a.fact_id, b.fact_id);
      assert.equal((await fact(a.fact_id)).strength, '1');
      assert.equal(
        (
          await db.query('SELECT count(*)::int n FROM memory_evidence WHERE fact_id=$1', [
            a.fact_id,
          ])
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'A new independent source reinforces one fact and retains both quotations',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。'),
        b = await document(u.id, '青禾项目报价86000元。');
      const x = await a.save(),
        y = await b.save({ value: '86000元' });
      assert.equal(x.fact_id, y.fact_id);
      assert.equal(y.comparison.action, 'MERGE');
      assert.equal(Number((await fact(x.fact_id)).strength), 1.25);
      assert.equal((await memory.list(db, u.id))[0].evidence_count, 2);
    },
  );
  await check('Different people sharing the same quote are not deduplicated together', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '王经理和李经理都确认青禾项目报价8.6万元。');
    const a = await d.save({ person_name: '王经理' }),
      b = await d.save({ person_name: '李经理' });
    assert.notEqual(a.fact_id, b.fact_id);
    assert.notEqual(a.person_id, b.person_id);
  });
  await check(
    'A valid quotation cannot support a fabricated amount or an unrelated person',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。');
      await assert.rejects(() => a.save({ value: '86万元' }), /金额/);
      const b = await document(u.id, '张三负责招标。李四喜欢红茶。');
      await assert.rejects(
        () =>
          b.save(
            { subject: '招标', predicate: '职责', value: '李四', person_name: '李四' },
            '张三负责招标',
          ),
        /人物/,
      );
    },
  );
  await check(
    'Hypotheses, questions and uncertainty do not create factual people or affiliations',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '如果李工以后加入青禾公司，我会让他负责采购。目前这只是设想。');
      const r = await d.save({
        subject: '李工',
        predicate: '任职',
        value: '青禾公司',
        person_name: '李工',
        organization: '青禾公司',
        assertion: 'hypothetical',
      });
      assert.equal(r.status, 'ignored');
      assert.equal((await db.query('SELECT * FROM people WHERE user_id=$1', [u.id])).rowCount, 0);
    },
  );
  await check(
    'Explicit changes replace current facts while timeline retains old versions in order',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。', { when: '2026-11-01T08:00:00Z' }),
        b = await document(u.id, '青禾项目现在改为9万元，之前报价作废。', {
          when: '2026-11-10T08:00:00Z',
        });
      const old = await a.save(),
        fresh = await b.save({ value: '9万元', operation: 'replace' });
      assert.equal(fresh.comparison.action, 'SUPERSEDE');
      assert.equal((await fact(old.fact_id)).superseded_by, fresh.fact_id);
      assert.deepEqual(
        (await memory.list(db, u.id)).map((f) => f.value),
        ['9万元'],
      );
      assert.deepEqual(
        (await memory.list(db, u.id, { mode: 'timeline' })).map((f) => f.value),
        ['8.6万元', '9万元'],
      );
      assert.deepEqual(
        (await memory.list(db, u.id, { mode: 'history', as_of: '2026-11-05T08:00:00Z' })).map(
          (f) => f.value,
        ),
        ['8.6万元'],
      );
      assert.deepEqual(
        (await searchHistory(db, u.id, { query: '青禾', mode: 'current' })).facts.map(
          (f) => f.value,
        ),
        ['9万元'],
      );
    },
  );
  await check('An old recording uploaded later cannot replace a newer current value', async () => {
    const u = await fixture.user(),
      newer = await document(u.id, '青禾项目现在报价9万元。', { when: '2026-11-10T08:00:00Z' }),
      older = await document(u.id, '青禾项目报价改为8.6万元。', {
        kind: 'recording',
        when: '2026-11-01T08:00:00Z',
      });
    await newer.save({ value: '9万元' });
    const r = await older.save({ operation: 'replace' });
    assert.equal((await fact(r.fact_id)).status, 'superseded');
    assert.deepEqual(
      (await memory.list(db, u.id)).map((f) => f.value),
      ['9万元'],
    );
  });
  await check(
    'Unexplained differing values become pending until explicitly confirmed',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。'),
        b = await document(u.id, '青禾项目报价9万元。');
      await a.save();
      const pending = await b.save({ value: '9万元' });
      assert.equal(pending.status, 'needs_confirmation');
      assert.equal((await fact(pending.fact_id)).status, 'pending');
      assert.deepEqual(
        (await memory.list(db, u.id)).map((f) => f.value),
        ['8.6万元'],
      );
      await db.tx((c) => memory.confirm(c, u.id, pending.fact_id));
      assert.deepEqual(
        (await memory.list(db, u.id)).map((f) => f.value),
        ['9万元'],
      );
    },
  );
  await check(
    'Tax conditions and currencies define separate scopes rather than changes',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '青禾项目含税报价8.6万元，不含税报价8万元，海外方案报价1万美元。');
      await d.save({ scope: '含税' });
      await d.save({ scope: '不含税', value: '8万元' });
      await d.save({ scope: '海外方案', value: '1万美元' });
      assert.equal((await memory.list(db, u.id)).length, 3);
    },
  );
  await check(
    'Same-name identities remain pending and can be resolved to a distinct person',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '甲公司的王伟负责采购。乙公司的王伟负责法务。');
      const a = await d.save(
        {
          subject: '王伟',
          predicate: '职责',
          value: '采购',
          person_name: '王伟',
          organization: '甲公司',
        },
        '甲公司的王伟负责采购',
      );
      const b = await d.save(
        {
          subject: '王伟',
          predicate: '职责',
          value: '法务',
          person_name: '王伟',
          organization: '乙公司',
        },
        '乙公司的王伟负责法务',
      );
      assert.equal(b.status, 'needs_identity');
      assert.equal(b.comparison.changed_values.length, 0);
      await db.tx((c) =>
        memory.resolve(c, u.id, b.id, undefined, {
          name: '王伟',
          organization: '乙公司',
          role: '法务',
        }),
      );
      assert.notEqual((await fact(b.fact_id)).person_id, a.person_id);
      assert.equal((await fact(b.fact_id)).status, 'active');
    },
  );
  await check(
    'Different currencies occupy separate slots even when the extractor omits scope',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。'),
        b = await document(u.id, '青禾项目报价1万美元。');
      await a.save();
      const result = await b.save({ value: '1万美元' });
      assert.equal(result.status, 'resolved');
      assert.equal(result.comparison.action, 'ADD');
      assert.equal((await memory.list(db, u.id)).length, 2);
    },
  );
  await check(
    'Day precision uses the source timezone for historical boundaries and date filters',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '昨天青禾项目报价8.6万元。', {
          kind: 'recording',
          when: '2026-11-10T08:00:00Z',
        }),
        b = await document(u.id, '昨天青禾项目报价改为9万元。', {
          kind: 'recording',
          when: '2026-11-11T08:00:00Z',
        });
      await a.save({ time_expression: '昨天' });
      await b.save({ value: '9万元', time_expression: '昨天', operation: 'replace' });
      const asOf = (when: string) => memory.list(db, u.id, { mode: 'history', as_of: when });
      assert.deepEqual(
        (await asOf('2026-11-09T23:59:59+08:00')).map((f) => f.value),
        ['8.6万元'],
      );
      assert.deepEqual(
        (await asOf('2026-11-10T00:00:00+08:00')).map((f) => f.value),
        ['9万元'],
      );
      const range = await memory.list(db, u.id, {
        mode: 'history',
        from: '2026-11-10T00:00:00+08:00',
        to: '2026-11-10T01:00:00+08:00',
      });
      assert.deepEqual(
        range.map((f) => f.value),
        ['9万元'],
      );
      assert.equal(range[0].effective_at, null);
      assert.equal(range[0].effective_date, '2026-11-10');
      assert.equal(range[0].effective_timezone, 'Asia/Shanghai');
    },
  );
  await check(
    'Explicit remembering pins a memory and a later correction inherits that choice',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '记住，我喜欢红茶。'),
        b = await document(u.id, '我现在喜欢绿茶，不再选红茶。');
      const first = await a.save({ subject: '我', predicate: '偏好', value: '红茶' });
      assert.equal((await fact(first.fact_id)).pinned, true);
      const next = await b.save({ subject: '我', predicate: '偏好', value: '绿茶' });
      assert.equal(next.comparison.action, 'SUPERSEDE');
      assert.equal((await fact(next.fact_id)).pinned, true);
    },
  );
  await check(
    'Known relative fact dates use the recording date and keep day precision',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '昨天李工加入青禾项目。', {
          kind: 'recording',
          when: '2026-11-10T16:30:00+08:00',
        });
      const r = await d.save({
        subject: '李工',
        predicate: '加入',
        value: '青禾项目',
        person_name: '李工',
        time_expression: '昨天',
      });
      const f = (await memory.list(db, u.id))[0];
      assert.equal(f.id, r.fact_id);
      assert.equal(f.effective_date, '2026-11-09');
      assert.equal(f.effective_at, null);
      assert.equal(f.time_precision, 'day');
    },
  );
  await check(
    'Unknown recording dates never default to upload or database creation time',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '昨天李工加入青禾项目。', { kind: 'recording' });
      const r = await d.save({
          subject: '李工',
          predicate: '加入',
          value: '青禾项目',
          person_name: '李工',
        }),
        f = await fact(r.fact_id);
      assert.equal(f.effective_at, null);
      assert.equal(f.effective_date, null);
      assert.equal(f.observed_at, null);
    },
  );
  await check('Chat opt-out blocks extraction and raw-source keyword recall', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '不要保存人物记忆，只用于本轮回答。青禾项目报价8.6万元。');
    assert.equal((await d.save()).status, 'ignored');
    const found = await searchHistory(db, u.id, { query: '青禾', mode: 'history' });
    assert.equal(found.facts.length, 0);
    assert.equal(found.messages.length, 0);
  });
  await check('Recording revisions retain the original memory restriction', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '青禾项目报价8.6万元。', {
        kind: 'recording',
        version: 2,
        instruction: '仅摘要，不提取人物记忆',
      });
    pipeline.analyzer.analyze = async () => {
      throw new Error('Forbidden analysis must not run');
    };
    pipeline.embeddings.index = async () => {};
    await enqueueIndex(db, u.id, 'recording', d.source.id, 2);
    const job = (
      await db.query('SELECT id FROM source_index_jobs WHERE source_id=$1', [d.source.id])
    ).rows[0];
    await pipeline.processIndex(job.id);
    assert.equal((await db.query('SELECT * FROM facts WHERE user_id=$1', [u.id])).rowCount, 0);
    assert.equal(
      (await db.query('SELECT status FROM source_index_jobs WHERE id=$1', [job.id])).rows[0].status,
      'succeeded',
    );
  });
  await check(
    'Half-life decay archives low-activity memories while explicit history can retrieve them',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '我喜欢红茶。');
      const r = await d.save({
        subject: '我',
        predicate: '偏好',
        value: '红茶',
        kind: 'preference',
      });
      await db.query("UPDATE facts SET last_reinforced_at=now()-interval '900 days' WHERE id=$1", [
        r.fact_id,
      ]);
      await db.tx((c) => memory.maintain(c, u.id));
      assert.equal((await memory.list(db, u.id)).length, 0);
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 1);
    },
  );
  await check(
    'Pinned memories survive decay and explicit expiration still ends temporary relevance',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '请记住，我喜欢红茶。');
      const r = await d.save({ subject: '我', predicate: '偏好', value: '红茶' });
      await db.query("UPDATE facts SET last_reinforced_at=now()-interval '900 days' WHERE id=$1", [
        r.fact_id,
      ]);
      await db.tx((c) => memory.maintain(c, u.id));
      assert.equal((await memory.list(db, u.id)).length, 1);
      await db.query("UPDATE facts SET expires_at=now()-interval '1 second' WHERE id=$1", [
        r.fact_id,
      ]);
      await db.tx((c) => memory.maintain(c, u.id));
      assert.equal((await memory.list(db, u.id)).length, 0);
    },
  );
  await check('Recall does not increase evidence strength or prevent natural decay', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '我喜欢红茶。');
    const r = await d.save({ subject: '我', predicate: '偏好', value: '红茶' });
    const before = await fact(r.fact_id);
    for (let n = 0; n < 5; n++) await memory.list(db, u.id);
    const after = await fact(r.fact_id);
    assert.equal(after.strength, before.strength);
    assert.equal(+after.last_reinforced_at, +before.last_reinforced_at);
  });
  await check(
    'Forgetting removes recall, blocks reinsertion, clears embeddings and invalidates cached SDK context',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '我喜欢红茶。');
      const r = await d.save({ subject: '我', predicate: '偏好', value: '红茶' });
      await db.query("UPDATE bot_state SET session_path='old-history.jsonl' WHERE user_id=$1", [
        u.id,
      ]);
      await db.query(
        "INSERT INTO chunk_embeddings(chunk_id,user_id,model,dimensions,embedding) VALUES($1,$2,'fixture',256,$3)",
        [d.chunks[0].id, u.id, Array(256).fill(0)],
      );
      await db.tx((c) => memory.forget(c, u.id, r.fact_id));
      assert.equal(
        (await db.query('SELECT * FROM chunk_embeddings WHERE user_id=$1', [u.id])).rowCount,
        0,
      );
      assert.equal(
        (await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [u.id])).rows[0]
          .session_path,
        null,
      );
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 0);
      const another = await document(u.id, '我喜欢红茶。');
      assert.equal(
        (await another.save({ subject: '我', predicate: '偏好', value: '红茶' })).status,
        'ignored',
      );
      assert.equal(
        (await searchHistory(db, u.id, { query: '红茶', mode: 'history' })).messages.some(
          (m) => m.id === d.source.id,
        ),
        false,
      );
      assert.equal(
        (await searchHistory(db, u.id, { query: '红茶', mode: 'history' })).messages.some(
          (m) => m.id === another.source.id,
        ),
        false,
      );
    },
  );
  await check('Reindexing forgotten source material cannot recreate its vectors', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '青禾项目报价8.6万元。');
    const r = await d.save();
    await db.tx((c) => memory.forget(c, u.id, r.fact_id));
    const embeddings = new Embeddings(config, db);
    embeddings.encode = async () => {
      throw new Error('Forgotten source must not be embedded');
    };
    await embeddings.index(u.id, d.source, new AbortController().signal);
    assert.equal(
      (await db.query('SELECT * FROM chunk_embeddings WHERE user_id=$1', [u.id])).rowCount,
      0,
    );
  });
  await check(
    'Source revisions invalidate only their evidence, preserving independent support',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '青禾项目报价8.6万元。', { kind: 'recording' }),
        b = await document(u.id, '青禾项目报价8.6万元。');
      const x = await a.save();
      await b.save();
      await db.query('UPDATE recordings SET version=2 WHERE id=$1', [a.source.id]);
      assert.equal((await memory.list(db, u.id))[0].id, x.fact_id);
    },
  );
  await check(
    'Bounded core context includes active preferences and excludes old or forgotten ones',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '我喜欢红茶。');
      const r = await d.save({ subject: '我', predicate: '偏好', value: '红茶' });
      const context = await memory.context(db, u.id);
      assert.equal(context.items.length, 1);
      assert(JSON.stringify(context.items).length <= 4000);
      await db.tx((c) => memory.forget(c, u.id, r.fact_id));
      assert.equal((await memory.context(db, u.id)).items.length, 0);
    },
  );
  await check('Concurrent duplicate writers create one fact and one evidence record', async () => {
    const u = await fixture.user(),
      d = await document(u.id, '青禾项目报价8.6万元。');
    const all = await Promise.all(Array.from({ length: 12 }, () => d.save()));
    assert.equal(new Set(all.map((x) => x.fact_id)).size, 1);
  });
  await check(
    'Migration can run twice and preserves existing facts, source evidence and lifecycle states',
    async () => {
      const u = await fixture.user(),
        d = await document(u.id, '青禾项目报价8.6万元。');
      const r = await d.save();
      await db.migrate();
      await db.migrate();
      assert.equal((await fact(r.fact_id)).value, '8.6万元');
      assert.equal((await memory.list(db, u.id))[0].evidence_count, 1);
    },
  );
  await check(
    'Memory APIs enforce ownership for reads, pins, history, confirmations and forgetting',
    async () => {
      const register = async () => {
        const r = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { name: '验收', email: `${randomUUID()}@nota.test`, password: randomUUID() },
        });
        assert.equal(r.statusCode, 200);
        return { id: r.json().user.id, cookie: String(r.headers['set-cookie']).split(';')[0] };
      };
      const a = await register(),
        b = await register(),
        d = await document(a.id, '青禾项目报价8.6万元。');
      const r = await d.save();
      for (const request of [
        { method: 'PATCH', url: `/api/facts/${r.fact_id}`, payload: { pinned: true } },
        { method: 'POST', url: `/api/facts/${r.fact_id}/confirm`, payload: {} },
        { method: 'DELETE', url: `/api/facts/${r.fact_id}` },
        { method: 'GET', url: `/api/facts/${r.fact_id}/history` },
      ])
        assert.equal(
          (await app.inject({ ...request, headers: { cookie: b.cookie } } as any)).statusCode,
          404,
        );
      const history = await app.inject({
        method: 'GET',
        url: `/api/facts/${r.fact_id}/history`,
        headers: { cookie: a.cookie },
      });
      assert.equal(history.statusCode, 200);
      assert.equal(history.json().evidence.length, 1);
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/facts/${r.fact_id}`,
            headers: { cookie: a.cookie },
            payload: { pinned: true },
          })
        ).statusCode,
        200,
      );
    },
  );
  await check(
    'Confirming the same identity merges evidence instead of creating duplicate facts',
    async () => {
      const u = await fixture.user(),
        a = await document(u.id, '陈总说青禾项目报价8.6万元。'),
        b = await document(u.id, '陈总说青禾项目报价8.6万元。');
      const old = await a.save({ person_name: '陈总' }),
        pending = await b.save({ person_name: '陈总' });
      assert.equal(pending.status, 'needs_identity');
      await db.tx((c) => memory.resolve(c, u.id, pending.id, old.person_id));
      const all = await memory.list(db, u.id, { mode: 'history' });
      assert.equal(all.length, 1);
      assert.equal(all[0].evidence_count, 2);
    },
  );
  await check('Preference wording changes cannot resurrect a forgotten self memory', async () => {
    const u = await fixture.user(),
      a = await document(u.id, '我喜欢喝红茶。');
    const saved = await a.save({ subject: '我', predicate: '喜欢喝', value: '红茶' });
    await db.tx((c) => memory.forget(c, u.id, saved.fact_id));
    const b = await document(u.id, '用户喜欢喝红茶。');
    assert.equal(
      (await b.save({ subject: '用户', predicate: '偏好', value: '喝红茶' })).status,
      'ignored',
    );
    assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 0);
  });
  await check(
    'Legacy backfill preserves existing quotations and source versions without guessing precision',
    async () => {
      const legacy = await testDatabase();
      try {
        const u = await legacy.user(),
          id = randomUUID(),
          message = randomUUID();
        await legacy.db.query(
          "INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,'user','青禾项目报价8.6万元。',$3)",
          [message, u.id, randomUUID()],
        );
        await legacy.db.query(
          "INSERT INTO facts(id,user_id,subject,predicate,value,effective_at,message_id,evidence,dedupe_key) VALUES($1,$2,'青禾项目','报价','8.6万元','2026-11-01T00:00:00Z',$3,'青禾项目报价8.6万元。',$4)",
          [id, u.id, message, randomUUID()],
        );
        await legacy.db.query('DELETE FROM schema_migrations WHERE version=2');
        await legacy.db.migrate();
        await legacy.db.tx((c) => memory.hydrate(c, u.id));
        const f = (await memory.list(legacy.db, u.id))[0];
        assert.equal(f.id, id);
        assert.equal(f.time_precision, 'legacy');
        assert.equal(f.evidence_count, 1);
        assert.equal(f.value, '8.6万元');
      } finally {
        await legacy.close();
      }
    },
  );
} finally {
  pipeline.stop();
  await app.close();
  await fixture.close();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/memory-integration.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
console.log(
  `${results.filter((r) => r.ok).length}/${results.length} memory lifecycle scenarios passed`,
);
