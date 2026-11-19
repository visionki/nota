/** Semantic decisions are controlled; evidence, retrieval, tools, SDK boundaries,
 * queue processing and database mutations use the real implementation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { MemoryReview } from '../src/server/memory-review.js';
import { MemoryService } from '../src/server/memory.js';
import {
  MemoryJobs,
  enqueueMemoryJob,
  enqueueCompactionMemory,
} from '../src/server/memory-jobs.js';
import { sourceDocument, saveChunks, evidenceRefs, enqueueIndex } from '../src/server/sources.js';
import { searchHistory } from '../src/server/domain.js';
import { createEvent, updateEvent } from '../src/server/agenda-domain.js';
import { Runtime } from '../src/server/runtime.js';
import { RecordingPipeline } from '../src/server/recording-pipeline.js';
import { RecordingAnalyzer } from '../src/server/recording-analysis.js';

const f = await testDatabase(),
  { db } = f,
  results: any[] = [],
  requests: any[] = [],
  replies: any[] = [];
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  requests.push(body);
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: '你好，今天想聊些什么？' }, null],
      [{}, 'stop'],
    ])
      res.write(
        `data: ${JSON.stringify({ id: 'semantic-fixture', object: 'chat.completion.chunk', created: 1, model: 'controlled-semantic', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    res.end('data: [DONE]\n\n');
  } else {
    const output = replies.shift();
    if (!output) {
      res.writeHead(500);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 },
      }),
    );
  }
});
await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
const config = {
  ...f.config,
  GMI_API_KEY: 'controlled-semantic',
  GMI_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
  GMI_MODEL: 'controlled-semantic',
  EMBEDDING_ENABLED: false,
};
const review = new MemoryReview(db, config),
  memory = new MemoryService(),
  jobs = new MemoryJobs(db, config);
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error) });
    console.error(`FAIL ${name}`, error);
  }
}
async function message(userId: string, text: string, when?: string) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,coalesce($5::timestamptz,now()))",
    [id, userId, text, randomUUID(), when ?? null],
  );
  const source = await sourceDocument(db, userId, 'message', id),
    chunks = await saveChunks(db, userId, source);
  return { source, refs: evidenceRefs(source, chunks, text) };
}
const decision = (action = 'ADD', target_ids: string[] = [], extra: any = {}) => ({
  action,
  target_ids,
  classification: 'durable',
  evidence_supported: true,
  reason: 'Controlled evidence-supported semantic decision',
  ...extra,
});
const prepare = (u: string, d: any, item: any) =>
  review.prepare(u, { ...item, source_refs: d.refs }, { source: d.source });
const apply = (u: string, p: any, d: any = decision()) => db.tx((c) => review.apply(c, u, p.id, d));
try {
  await check(
    'Malformed material output receives one schema repair attempt and keeps mandatory original quotations',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '我住在深圳。');
      replies.push(
        { summary: '住在深圳', facts: [{ subject: '我', predicate: '居住地', value: '深圳' }] },
        {
          summary: '住在深圳',
          facts: [{ subject: '我', predicate: '居住地', value: '深圳', evidence: d.source.text }],
        },
      );
      const analyzer = new RecordingAnalyzer(config);
      const output = await analyzer.analyze(d.source, '整理记忆', new AbortController().signal);
      assert.equal(output.facts[0].evidence, d.source.text);
      assert.equal(analyzer.requestAttempts, 2);
    },
  );
  await check('Malformed semantic output retries once and meters both attempts', async () => {
    const u = await f.user(),
      d = await message(u.id, '我住在深圳。');
    const p = await prepare(u.id, d, { subject: '我', predicate: '居住地', value: '深圳' });
    replies.push(
      { decisions: [{ index: 0, ...decision(), canonical: 'invalid' }] },
      { decisions: [{ index: 0, ...decision() }] },
    );
    const [result] = await review.decide(u.id, [p], 'fixture', new AbortController().signal);
    assert.equal(result.action, 'ADD');
    const run = (
      await db.query('SELECT requests,status FROM memory_model_runs WHERE user_id=$1', [u.id])
    ).rows[0];
    assert.equal(run.requests, 2);
    assert.equal(run.status, 'succeeded');
  });
  await check('Monetary evidence checks apply to any open attribute name', async () => {
    const u = await f.user(),
      d = await message(u.id, '我的月租是两千元。');
    const p = await prepare(u.id, d, { subject: '我', predicate: '月租', value: '两万元' });
    await assert.rejects(
      () => apply(u.id, p),
      (e) => (e as any).status === 400,
    );
    assert.equal((await memory.list(db, u.id)).length, 0);
  });
  await check(
    'A semantic merge cannot collapse different currencies under an open attribute',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '场地费用一万元。');
      const first = await apply(
        u.id,
        await prepare(u.id, a, { subject: '场地', predicate: '费用', value: '一万元' }),
      );
      const b = await message(u.id, '场地费用一万美元。');
      const p = await prepare(u.id, b, { subject: '场地', predicate: '费用', value: '一万美元' });
      await assert.rejects(
        () => apply(u.id, p, decision('MERGE', [first.fact.id])),
        (e) => (e as any).status === 409,
      );
      assert.equal((await memory.list(db, u.id))[0].value, '一万元');
    },
  );
  await check(
    'A short pronoun quote expands to nearby original antecedents before semantic judgment',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '王悦是我姐姐。她在苏州工作。');
      const p = await review.prepare(u.id, {
        subject: '王悦',
        predicate: '工作地',
        value: '苏州',
        person_name: '王悦',
        supporting_evidence: [{ source_id: d.source.id, quote: '她在苏州工作。' }],
      });
      assert(p.source_refs.some((r) => r.quote.includes('王悦是我姐姐')));
      assert((await apply(u.id, p)).fact);
    },
  );
  await check(
    'Semantic review can correct the draft classifier without discarding lasting work information',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '场地方案费用两万元，双方尚未确认。');
      const p = await prepare(u.id, d, {
        subject: '场地方案',
        predicate: '费用',
        value: '两万元',
        purpose: 'business',
        certainty: 'tentative',
        qualifiers: '尚未确认',
      });
      const saved = await apply(u.id, p, decision());
      assert.equal(saved.fact.purpose, 'durable');
      assert.equal(saved.fact.certainty, 'tentative');
    },
  );
  await check(
    'Equivalent qualifier wording reinforces a selected claim without requiring literal equality',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '方案费用两万元，尚未确认。');
      const first = await apply(
        u.id,
        await prepare(u.id, a, {
          subject: '方案',
          predicate: '费用',
          value: '两万元',
          certainty: 'tentative',
          qualifiers: '尚未确认',
        }),
      );
      const b = await message(u.id, '方案费用仍是两万元，还没有确认。');
      const p = await prepare(u.id, b, {
        subject: '方案',
        predicate: '费用',
        value: '两万元',
        certainty: 'tentative',
        qualifiers: '还没有确认',
      });
      const merged = await apply(u.id, p, decision('MERGE', [first.fact.id]));
      assert.equal(merged.fact.id, first.fact.id);
      assert.equal((await memory.list(db, u.id))[0].evidence_count, 2);
    },
  );
  await check(
    'Semantic paraphrases retain exact original quotations without substring-value rejection',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '陈总是LOL项目的负责人');
      const p = await prepare(u.id, d, {
        subject: '陈总',
        predicate: '职责',
        value: 'LOL项目负责人',
        person_name: '陈总',
        kind: 'relationship',
      });
      const saved = await apply(u.id, p);
      assert.equal(saved.memory_status, 'resolved');
      assert.equal(saved.fact.value, 'LOL项目负责人');
      assert.equal(saved.fact.evidence, '陈总是LOL项目的负责人');
    },
  );
  await check(
    'A pronoun resolution can be supported by multiple independently validated messages',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '我们刚才说的是LOL项目。'),
        b = await message(u.id, '这个就是陈总负责的。');
      const p = await review.prepare(u.id, {
        subject: '陈总',
        predicate: '负责',
        value: 'LOL项目',
        person_name: '陈总',
        kind: 'relationship',
        supporting_evidence: [
          { source_id: b.source.id, quote: b.source.text },
          { source_id: a.source.id, quote: a.source.text },
        ],
      });
      const saved = await apply(u.id, p);
      assert.equal(saved.memory_status, 'resolved');
      assert.equal(
        (
          await db.query('SELECT count(*)::int n FROM memory_evidence WHERE fact_id=$1', [
            saved.fact.id,
          ])
        ).rows[0].n,
        2,
      );
    },
  );
  await check(
    'Cross-account, edited or invented supporting quotations cannot be committed',
    async () => {
      const a = await f.user(),
        b = await f.user(),
        d = await message(a.id, '我住在深圳。');
      await assert.rejects(
        () =>
          review.prepare(b.id, {
            subject: '我',
            predicate: '常住城市',
            value: '深圳',
            source_refs: d.refs,
          }),
        (e) => (e as any).status === 404,
      );
      await assert.rejects(
        () =>
          review.prepare(a.id, {
            subject: '我',
            predicate: '常住城市',
            value: '北京',
            source_refs: [{ ...d.refs[0], quote: '我住在北京。' }],
          }),
        (e) => (e as any).status === 400,
      );
    },
  );
  await check(
    'Business time, duration and notification parameters produce no durable facts',
    async () => {
      const u = await f.user();
      for (const [text, predicate, value] of [
        ['19点大概2小时吧，提前提醒我。', '时间', '19点'],
        ['19点大概2小时吧，提前提醒我。', '预计时长', '大概2小时'],
        ['提前提醒我。', '提醒要求', '提前提醒我'],
      ]) {
        const d = await message(u.id, text),
          p = await prepare(u.id, d, {
            subject: '提醒事项',
            predicate,
            value,
            purpose: 'business',
          });
        const saved = await apply(u.id, p, decision('IGNORE', [], { classification: 'business' }));
        assert.equal(saved.memory_status, 'ignored');
      }
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 0);
    },
  );
  await check(
    'A lasting notification preference is preserved despite containing reminder words',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '以后所有安排默认提前半小时通知我。');
      const saved = await apply(
        u.id,
        await prepare(u.id, d, {
          subject: '我',
          predicate: '默认通知提前量',
          value: '半小时',
          kind: 'preference',
          scope: '所有安排',
        }),
      );
      assert.equal(saved.fact.kind, 'preference');
      assert.equal((await memory.context(db, u.id)).items.length, 1);
    },
  );
  await check(
    'Relationships are open attributes, including new domains unrelated to financial examples',
    async () => {
      const u = await f.user();
      for (const [text, subject, predicate, value, kind] of [
        ['我住在深圳。', '我', '常住城市', '深圳', 'fact'],
        ['小林是我的室友。', '小林', '与我的关系', '室友', 'relationship'],
        ['我使用Linux开发。', '我', '开发环境', 'Linux', 'preference'],
        ['我的长期目标是学会西班牙语。', '我', '学习目标', '学会西班牙语', 'goal'],
      ]) {
        const d = await message(u.id, text);
        await apply(u.id, await prepare(u.id, d, { subject, predicate, value, kind }));
      }
      const rows = await memory.list(db, u.id);
      assert.equal(rows.length, 4);
      assert(rows.every((r) => r.predicate !== '报价'));
      assert.equal(rows.find((r) => r.kind === 'goal').expires_at, null);
    },
  );
  await check(
    'Equivalent wording merges evidence into the selected fact without hardcoded predicate aliases',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '我希望回复简洁。');
      const first = await apply(
        u.id,
        await prepare(u.id, a, {
          subject: '我',
          predicate: '回复风格',
          value: '简洁',
          kind: 'preference',
        }),
      );
      const b = await message(u.id, '回答短一点就好。'),
        p = await prepare(u.id, b, {
          subject: '用户',
          predicate: '沟通习惯',
          value: '短一点',
          kind: 'preference',
        });
      assert(p.related.some((r) => r.id === first.fact.id));
      const merged = await apply(u.id, p, decision('MERGE', [first.fact.id]));
      assert.equal(merged.fact.id, first.fact.id);
      assert.equal((await memory.list(db, u.id))[0].evidence_count, 2);
    },
  );
  await check(
    'Multiple hobbies coexist; a later change replaces only the explicitly selected member',
    async () => {
      const u = await f.user();
      const ids = [];
      for (const value of ['游泳', '徒步']) {
        const d = await message(u.id, `我的爱好有${value}。`);
        ids.push(
          (
            await apply(
              u.id,
              await prepare(u.id, d, {
                subject: '我',
                predicate: '爱好',
                value,
                kind: 'preference',
              }),
            )
          ).fact.id,
        );
      }
      assert.equal((await memory.list(db, u.id)).length, 2);
      const d = await message(u.id, '我不再游泳，改为骑行。'),
        p = await prepare(u.id, d, {
          subject: '我',
          predicate: '爱好',
          value: '骑行',
          kind: 'preference',
        });
      await apply(u.id, p, decision('SUPERSEDE', [ids[0]]));
      assert.deepEqual(
        (await memory.list(db, u.id)).map((r) => r.value).sort(),
        ['徒步', '骑行'].sort(),
      );
    },
  );
  await check(
    'Confirming a selected conflict preserves other coexisting values in the same slot',
    async () => {
      const u = await f.user(),
        ids: string[] = [];
      for (const value of ['跑步', '摄影']) {
        const d = await message(u.id, `我的爱好是${value}。`);
        ids.push(
          (
            await apply(
              u.id,
              await prepare(u.id, d, {
                subject: '我',
                predicate: '爱好',
                value,
                kind: 'preference',
              }),
            )
          ).fact.id,
        );
      }
      const d = await message(u.id, '我可能改为骑车。');
      const pending = await apply(
        u.id,
        await prepare(u.id, d, {
          subject: '我',
          predicate: '爱好',
          value: '骑车',
          kind: 'preference',
        }),
        decision('CONFLICT', [ids[0]]),
      );
      assert.equal(pending.fact.status, 'pending');
      await db.tx((c) => memory.confirm(c, u.id, pending.fact.id));
      assert.deepEqual(
        (await memory.list(db, u.id)).map((x) => x.value).sort(),
        ['摄影', '骑车'].sort(),
      );
    },
  );
  await check(
    'Truth changes after retrieval reject stale semantic updates while reinforcement alone is safe',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '我住在深圳。'),
        first = await apply(
          u.id,
          await prepare(u.id, a, { subject: '我', predicate: '常住城市', value: '深圳' }),
        );
      const d = await message(u.id, '我搬到杭州了。'),
        stale = await prepare(u.id, d, { subject: '我', predicate: '常住城市', value: '杭州' });
      const c = await message(u.id, '我搬到成都了。'),
        fresh = await prepare(u.id, c, { subject: '我', predicate: '常住城市', value: '成都' });
      await apply(u.id, fresh, decision('SUPERSEDE', [first.fact.id]));
      await assert.rejects(
        () => apply(u.id, stale, decision('SUPERSEDE', [first.fact.id])),
        (e) => (e as any).code === 'memory_changed',
      );
    },
  );
  await check(
    'Tentative information retains its qualifier and cannot merge with a confirmed claim',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '方案预算两万元，但还没有确认。');
      const first = await apply(
        u.id,
        await prepare(u.id, a, {
          subject: '方案',
          predicate: '预算',
          value: '两万元',
          certainty: 'tentative',
          qualifiers: '尚未确认',
        }),
      );
      const b = await message(u.id, '方案预算两万元已经确认。'),
        p = await prepare(u.id, b, {
          subject: '方案',
          predicate: '预算',
          value: '两万元',
          certainty: 'confirmed',
          qualifiers: '已确认',
        });
      await assert.rejects(
        () => apply(u.id, p, decision('MERGE', [first.fact.id])),
        (e) => (e as any).status === 409,
      );
      const saved = await apply(u.id, p, decision('SUPERSEDE', [first.fact.id]));
      assert.equal(saved.fact.certainty, 'confirmed');
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 2);
    },
  );
  await check(
    'A relation references the live event and never owns a duplicate event time',
    async () => {
      const u = await f.user(),
        event = await db.tx((c) =>
          createEvent(c, u.id, {
            title: '合作沟通',
            starts_at: '2031-11-20T19:00:00+08:00',
            timezone: 'Asia/Shanghai',
          }),
        );
      const d = await message(u.id, '下周与陈总会面讨论合作。'),
        saved = await apply(
          u.id,
          await prepare(u.id, d, {
            subject: '陈总',
            predicate: '会面议题',
            value: '合作',
            purpose: 'event_context',
            business_refs: [{ kind: 'event', id: event.id }],
          }),
        );
      await db.tx((c) =>
        updateEvent(c, u.id, event.id, { starts_at: '2031-11-20T20:00:00+08:00' }),
      );
      const current = (await memory.list(db, u.id))[0];
      assert.equal(current.id, saved.fact.id);
      assert.equal(new Date(current.business_links[0].starts_at).getUTCHours(), 12);
      assert(!current.value.includes('19'));
      const found = await searchHistory(db, u.id, { query: '合作' });
      assert(found.business_objects.some((b) => b.id === event.id));
    },
  );
  await check(
    'Forgotten source material cannot be reintroduced through a paraphrased proposal or a success replay',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '我喜欢简洁回答。'),
        p = await prepare(u.id, d, {
          subject: '我',
          predicate: '回答偏好',
          value: '简洁',
          kind: 'preference',
        }),
        saved = await apply(u.id, p);
      await db.tx((c) => memory.forget(c, u.id, saved.fact.id));
      assert.equal((await apply(u.id, p)).memory_status, 'forgotten');
      const again = await prepare(u.id, d, {
        subject: '我',
        predicate: '沟通风格',
        value: '简短',
        kind: 'preference',
      });
      assert(again.blocked);
      assert.equal((await apply(u.id, again)).memory_status, 'ignored');
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 0);
    },
  );
  await check('Opt-out applies to every member of a multi-message evidence chain', async () => {
    const u = await f.user(),
      a = await message(u.id, '不要记住：小林是我的室友。'),
      b = await message(u.id, '他负责采购。');
    const p = await review.prepare(u.id, {
      subject: '小林',
      predicate: '职责',
      value: '采购',
      supporting_evidence: [
        { source_id: b.source.id, quote: b.source.text },
        { source_id: a.source.id, quote: a.source.text },
      ],
    });
    assert(p.blocked);
    assert.equal((await apply(u.id, p)).memory_status, 'ignored');
  });
  await check(
    'SDK boundaries create one durable compaction task and recover it idempotently',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '我住在深圳。'),
        b = await message(u.id, '今天聊点天气。');
      const entry = (id: string, source: string) => ({
        id,
        type: 'message',
        message: { role: 'user', content: JSON.stringify({ source_messages: [{ id: source }] }) },
      });
      const branch = [
        entry('one', a.source.id),
        entry('two', b.source.id),
        { id: 'compact-one', type: 'compaction', firstKeptEntryId: 'two' },
      ];
      await enqueueCompactionMemory(db, u.id, 'owned-session', branch, 0);
      await enqueueCompactionMemory(db, u.id, 'owned-session', branch, 0);
      const rows = (await db.query('SELECT * FROM memory_jobs WHERE user_id=$1', [u.id])).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].payload.source_ids, [a.source.id]);
      replies.push(
        {
          summary: '用户居住在深圳。',
          facts: [
            {
              subject: '我',
              predicate: '常住城市',
              value: '深圳',
              evidence: a.source.text,
              supporting_evidence: [
                { source_kind: 'message', source_id: a.source.id, quote: a.source.text },
              ],
            },
          ],
          actions: [],
          uncertainties: [],
        },
        { decisions: [{ index: 0, ...decision() }] },
      );
      await jobs.process(rows[0].id);
      const job = (await db.query('SELECT * FROM memory_jobs WHERE id=$1', [rows[0].id])).rows[0];
      assert.equal(job.status, 'succeeded', job.last_error);
      assert.equal((await memory.list(db, u.id)).length, 1);
      const before = requests.length;
      await jobs.process(rows[0].id);
      assert.equal(requests.length, before);
      assert.equal(
        (
          await db.query('SELECT count(*)::int n FROM memory_scan_receipts WHERE user_id=$1', [
            u.id,
          ])
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'A compaction extraction queued before forgetting cannot write into the new context epoch',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '我住在深圳。');
      const id = await enqueueMemoryJob(db, u.id, 'compaction', 'epoch-test', {
        source_ids: [d.source.id],
        memory_epoch: 0,
      });
      await db.query('UPDATE bot_state SET memory_epoch=1 WHERE user_id=$1', [u.id]);
      const before = requests.length;
      await jobs.process(id);
      assert.equal(requests.length, before);
      assert.equal(
        (await db.query('SELECT status FROM memory_jobs WHERE id=$1', [id])).rows[0].status,
        'failed',
      );
      assert.equal((await memory.list(db, u.id)).length, 0);
    },
  );
  await check(
    'A resumed compaction cursor keeps its frozen chunk range even after another receipt is recorded',
    async () => {
      const u = await f.user(),
        a = await message(u.id, '我喜欢摄影。'),
        b = await message(u.id, '我住在杭州。');
      const first = await apply(
        u.id,
        await prepare(u.id, a, { subject: '我', predicate: '爱好', value: '摄影' }),
      );
      const id = await enqueueMemoryJob(db, u.id, 'compaction', 'frozen-cursor', {
        source_ids: [a.source.id, b.source.id],
        memory_epoch: 0,
        cursor: 1,
        batch_chunk_ids: [[a.refs[0].chunk_id], [b.refs[0].chunk_id]],
      });
      await db.query(
        'INSERT INTO memory_scan_receipts(user_id,message_id,job_id) VALUES($1,$2,$3)',
        [u.id, a.source.id, id],
      );
      replies.push(
        {
          summary: '住在杭州',
          facts: [
            {
              subject: '我',
              predicate: '居住地',
              value: '杭州',
              evidence: b.source.text,
              supporting_evidence: [{ source_id: b.source.id, quote: b.source.text }],
            },
          ],
        },
        { decisions: [{ index: 0, ...decision() }] },
      );
      const before = requests.length;
      await jobs.process(id);
      assert.equal(
        (await db.query('SELECT status FROM memory_jobs WHERE id=$1', [id])).rows[0].status,
        'succeeded',
      );
      assert.equal(requests.length - before, 2);
      const fs = await memory.list(db, u.id);
      assert.equal(fs.length, 2);
      assert.equal(fs.find((x) => x.id === first.fact.id)?.evidence_count, 1);
    },
  );
  await check(
    'Legacy reclassification archives business fragments without deleting calendars or resetting context',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '19点大概2小时吧，提前提醒我。'),
        old = await db.tx((c) =>
          memory.remember(c, u.id, d.source, {
            subject: '提醒事项',
            predicate: '时间',
            value: '19点',
            source_refs: d.refs,
          }),
        );
      await db.query("UPDATE bot_state SET session_path='preserved.jsonl' WHERE user_id=$1", [
        u.id,
      ]);
      const id = await enqueueMemoryJob(db, u.id, 'reclassify', 'cleanup-test', {
        fact_ids: [old.fact_id],
      });
      replies.push({
        decisions: [
          {
            index: 0,
            ...decision('IGNORE', [], {
              classification: 'business',
              reason: '时间属于既有事项的操作参数',
            }),
          },
        ],
      });
      await jobs.process(id);
      assert.equal((await memory.list(db, u.id, { mode: 'history' })).length, 0);
      assert.equal(
        (await db.query('SELECT status,purpose FROM facts WHERE id=$1', [old.fact_id])).rows[0]
          .status,
        'active',
      );
      assert.equal(
        (await db.query('SELECT session_path FROM bot_state WHERE user_id=$1', [u.id])).rows[0]
          .session_path,
        'preserved.jsonl',
      );
    },
  );
  await check(
    'Legacy reclassification corrects lost uncertainty without inventing an unknown recording date',
    async () => {
      const u = await f.user(),
        id = randomUUID(),
        text = '场地费用两万元，双方尚未确认。';
      await db.query(
        "INSERT INTO recordings(id,user_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,status) VALUES($1,$2,'旧记录',$3,'test.wav','audio/wav',100,1,$4,'ready')",
        [id, u.id, randomUUID(), text],
      );
      const source = await sourceDocument(db, u.id, 'recording', id),
        chunks = await saveChunks(db, u.id, source);
      const old = await db.tx((c) =>
        memory.remember(c, u.id, source, {
          subject: '场地',
          predicate: '费用',
          value: '两万元',
          source_refs: evidenceRefs(source, chunks, text),
        }),
      );
      const jobId = await enqueueMemoryJob(db, u.id, 'reclassify', 'repair-unknown-time', {
        fact_ids: [old.fact_id],
      });
      replies.push({
        decisions: [
          {
            index: 0,
            ...decision('SUPERSEDE', [old.fact_id], {
              canonical: { certainty: 'tentative', qualifiers: '双方尚未确认' },
            }),
          },
        ],
      });
      await jobs.process(jobId);
      const job = (await db.query('SELECT * FROM memory_jobs WHERE id=$1', [jobId])).rows[0];
      assert.equal(job.status, 'succeeded', job.last_error);
      const fs = await memory.list(db, u.id);
      assert.equal(fs.length, 1);
      assert.equal(fs[0].certainty, 'tentative');
      assert.equal(fs[0].observed_at, null);
      assert.equal(
        (await db.query('SELECT status FROM facts WHERE id=$1', [old.fact_id])).rows[0].status,
        'superseded',
      );
    },
  );
  await check(
    'Old ignored semantic equivalents can be repaired against their actual original evidence',
    async () => {
      const u = await f.user(),
        d = await message(u.id, '陈总是LOL项目的负责人'),
        old = await db.tx((c) =>
          memory.remember(c, u.id, d.source, {
            subject: '陈总',
            predicate: '职责',
            value: 'LOL项目负责人',
            person_name: '陈总',
            source_refs: d.refs,
          }),
        );
      assert.equal(old.status, 'ignored');
      const id = await enqueueMemoryJob(db, u.id, 'reclassify', 'repair-test', {
        candidate_ids: [old.id],
      });
      replies.push({ decisions: [{ index: 0, ...decision() }] });
      await jobs.process(id);
      const job = (await db.query('SELECT * FROM memory_jobs WHERE id=$1', [id])).rows[0];
      assert.equal(job.status, 'succeeded', job.last_error);
      assert.equal((await memory.list(db, u.id)).length, 1);
    },
  );
  await check(
    'Ordinary chat through real queue and all workers triggers zero extraction, review or embedding calls',
    async () => {
      const ordinary = await testDatabase(),
        { db } = ordinary;
      const u = await ordinary.user(),
        runtime = new Runtime(db, {
          ...config,
          DATABASE_URL: ordinary.config.DATABASE_URL,
          DATA_DIR: ordinary.config.DATA_DIR,
          EMBEDDING_ENABLED: true,
          OPENAI_API_KEY: 'controlled-embedding',
          OPENAI_BASE_URL: config.GMI_BASE_URL,
        });
      const before = requests.length;
      try {
        await runtime.start();
        const op = await runtime.ops.submit(u.id, randomUUID(), '你好，随便聊聊。');
        const deadline = Date.now() + 20000;
        let status = '';
        while (Date.now() < deadline) {
          const r = (await db.query('SELECT status FROM operations WHERE id=$1', [op.id])).rows[0];
          status = r.status;
          const idx = (
            await db.query(
              "SELECT count(*)::int n FROM source_index_jobs WHERE user_id=$1 AND status='succeeded'",
              [u.id],
            )
          ).rows[0].n;
          if (status === 'succeeded' && idx > 0) break;
          await new Promise((done) => setTimeout(done, 100));
        }
        assert.equal(status, 'succeeded');
        const sent = requests.slice(before);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].stream, true);
        assert.equal(
          (await db.query('SELECT count(*)::int n FROM memory_model_runs WHERE user_id=$1', [u.id]))
            .rows[0].n,
          0,
        );
        assert.equal((await memory.list(db, u.id)).length, 0);
        assert.equal(
          (await db.query('SELECT memory_summary FROM operations WHERE id=$1', [op.id])).rows[0]
            .memory_summary.status,
          'not_requested',
        );
      } finally {
        await runtime.stop();
        await ordinary.close();
      }
    },
  );
  assert.equal(replies.length, 0, 'All controlled model responses should have been consumed');
} finally {
  jobs.stop();
  upstream.closeAllConnections();
  await new Promise<void>((done) => upstream.close(() => done()));
  await f.close();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/memory-semantic-integration.json',
    JSON.stringify(
      { at: new Date().toISOString(), results, model_requests: requests.length },
      null,
      2,
    ),
  );
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
console.log(
  `${results.filter((r) => r.ok).length}/${results.length} semantic memory scenarios passed`,
);
