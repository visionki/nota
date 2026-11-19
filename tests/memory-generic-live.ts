/** Real extraction + semantic review + persistence on isolated, synthetic data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { RecordingAnalyzer, withEvidence } from '../src/server/recording-analysis.js';
import { MemoryService } from '../src/server/memory.js';
import { MemoryReview } from '../src/server/memory-review.js';
import { MemoryJobs, enqueueMemoryJob } from '../src/server/memory-jobs.js';
import { sourceDocument, saveChunks } from '../src/server/sources.js';

const f = await testDatabase(),
  actual = loadConfig(),
  { db } = f;
const config = {
  ...f.config,
  GMI_API_KEY: actual.GMI_API_KEY,
  GMI_BASE_URL: actual.GMI_BASE_URL,
  GMI_MODEL: actual.GMI_MODEL,
  EMBEDDING_ENABLED: false,
  MAX_RUN_SECONDS: 240,
};
const memory = new MemoryService(),
  review = new MemoryReview(db, config),
  jobs = new MemoryJobs(db, config);
const report: any = {
  at: new Date().toISOString(),
  model: config.GMI_MODEL,
  scope:
    'Isolated database; synthetic Chinese text; real recording extraction, candidate retrieval, semantic review, evidence validation, persistence and compaction worker. No ASR; ordinary conversational Agent evaluated separately.',
  cases: [],
  longitudinal: [],
  extraction_requests: 0,
  extraction_tokens: 0,
  traces: [],
};
async function source(
  user: string,
  text: string,
  when = '2026-11-13T06:00:00Z',
  kind: 'message' | 'recording' = 'recording',
) {
  const id = randomUUID();
  if (kind === 'message')
    await db.query(
      "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,$5)",
      [id, user, text, randomUUID(), when],
    );
  else {
    const op = randomUUID();
    await db.query(
      "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status,executor) VALUES($1,$2,$3,'generic-live','recording',$4,'succeeded','recording')",
      [op, user, randomUUID(), { recording_id: id }],
    );
    await db.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,recorded_at,recorded_timezone,status) VALUES($1,$2,$3,'通用记忆合成评测',$4,'synthetic.wav','audio/wav',100,1,$5,1,$6,'Asia/Shanghai','ready')",
      [id, user, op, randomUUID(), text, when],
    );
  }
  return sourceDocument(db, user, kind, id);
}
async function extract(user: string, text: string, when?: string) {
  const doc = await source(user, text, when),
    chunks = await saveChunks(db, user, doc);
  const analyzer = new RecordingAnalyzer(config, (u) => {
    report.extraction_tokens += u.total_tokens ?? 0;
  });
  const start = Date.now();
  let output;
  try {
    output = await analyzer.analyze(
      doc,
      '整理通用资料与重要记忆，保留原义和限定条件。',
      new AbortController().signal,
    );
  } finally {
    report.extraction_requests += analyzer.requestAttempts;
  }
  const prepared = withEvidence(doc, chunks, output);
  const trace: any = { user, input: text, output, memory_rejections: prepared.memory_rejections };
  report.traces.push(trace);
  const plans = await review.review(
    user,
    doc,
    prepared.facts,
    'recording',
    new AbortController().signal,
  );
  const results = await db.tx(async (c) => {
    const out = [];
    for (const p of plans) out.push(await review.apply(c, user, p.proposal_id, p.decision));
    return out;
  });
  Object.assign(trace, { ms: Date.now() - start, results });
  return results;
}
const current = (u: string) => memory.list(db, u, { limit: 200 });
const joined = (f: any) => `${f.subject} ${f.predicate} ${f.value} ${f.scope} ${f.qualifiers}`;
const has = (fs: any[], ...patterns: RegExp[]) =>
  fs.some((f) => patterns.every((p) => p.test(joined(f))));
const cases: { id: string; input: string; expect: string; assess: (fs: any[]) => boolean }[] = [
  {
    id: 'role_paraphrase',
    input: '陈总是LOL项目的负责人。',
    expect: '陈总与LOL项目的职责关系',
    assess: (fs) => has(fs, /陈总/, /LOL/, /负责/),
  },
  {
    id: 'roommate',
    input: '小林是我的室友，我们一起住在杭州。',
    expect: '室友关系和居住背景',
    assess: (fs) => has(fs, /小林/, /室友/) && has(fs, /杭州/),
  },
  {
    id: 'technical_preference',
    input: '我日常开发主力用Linux，最熟悉Rust。',
    expect: '开放的技术习惯',
    assess: (fs) => has(fs, /Linux/i) && has(fs, /Rust/i),
  },
  {
    id: 'lasting_notification_preference',
    input: '以后我所有日程都默认提前半小时提醒。',
    expect: '可复用的提醒偏好',
    assess: (fs) => has(fs, /提醒|通知/, /半小时|30分/),
  },
  {
    id: 'reminder_fragments',
    input: '今晚约了陈总吃饭，19点，大概两小时吧，提前提醒我。',
    expect: '零条长期事实，日期时长提醒归业务对象',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'standalone_reminder',
    input: '明天早上八点提醒我出门。',
    expect: '零条长期事实',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'task_parameters',
    input: '帮我建一个待办，周五前把报告发给周工。',
    expect: '零条长期事实',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'calendar_only',
    input: '把今天下午三点的例会改到四点，地点改到会议室B。',
    expect: '零条长期事实',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'question_only',
    input: '小周是我的客户吗？我不确定。',
    expect: '不把提问写成关系',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'hypothetical',
    input: '假设赵敏是团队负责人，我们可能会让她来组织评审。',
    expect: '不把假设写成关系',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'opt_out',
    input: '以下只用于这轮，不要记住：我住在上海，小李是我的合伙人。',
    expect: '尊重不记忆指令',
    assess: (fs) => fs.length === 0,
  },
  {
    id: 'tentative_and_goal',
    input: '上次LOL项目成功报价三十万，但是我们这边还没确认。我想把最终预算压到二十五万。',
    expect: '保留未确认与目标两个状态',
    assess: (fs) =>
      fs.some(
        (x) =>
          /三十万|30万/.test(joined(x)) &&
          x.certainty === 'tentative' &&
          /未确认|没确认|尚未/.test(x.qualifiers),
      ) &&
      fs.some((x) => /二十五万|25万/.test(joined(x)) && x.certainty === 'goal') &&
      !fs.some((x) => /三十万|30万/.test(joined(x)) && x.certainty === 'confirmed'),
  },
  {
    id: 'multiple_hobbies',
    input: '我长期的爱好是跑步、游泳和摄影。',
    expect: '多个爱好共存',
    assess: (fs) => has(fs, /跑步/) && has(fs, /游泳/) && has(fs, /摄影/),
  },
  {
    id: 'language_goal',
    input: '我一直想把日语练到能独立工作交流的水平，目前还没有达到。',
    expect: '持续目标而非已达到的水平，无强制30天失效',
    assess: (fs) =>
      fs.some(
        (x) =>
          /日语/.test(joined(x)) && (x.certainty === 'goal' || x.kind === 'goal') && !x.expires_at,
      ),
  },
  {
    id: 'family_relation',
    input: '王悦是我姐姐，她在苏州工作。',
    expect: '亲属关系与工作背景',
    assess: (fs) => has(fs, /王悦/, /姐/) && has(fs, /苏州/),
  },
  {
    id: 'dietary_constraint',
    input: '我对花生过敏，点餐时必须避开花生。',
    expect: '持续饮食约束',
    assess: (fs) => has(fs, /花生/, /过敏|避开/),
  },
  {
    id: 'collaboration_relation',
    input: '星河读书会是我和阿芸共同组织的，我负责选书，她负责场地。',
    expect: '开放的协作职责',
    assess: (fs) => has(fs, /我|用户|星河/, /选书/) && has(fs, /阿芸/, /场地/),
  },
  {
    id: 'important_outcome',
    input: '星河读书会的首场活动已经办成，共有32人参加，后续每月继续。',
    expect: '重要事件结果，数量准确',
    assess: (fs) => has(fs, /星河/, /32|三十二/),
  },
  {
    id: 'time_qualifier',
    input: '从2026年11月10日起，我搬到成都常住，之前住南京。',
    expect: '当前居住地为成都并保留发生日期',
    assess: (fs) =>
      has(fs, /成都/) &&
      fs.some(
        (x) =>
          /成都/.test(joined(x)) &&
          (String(x.effective_date).startsWith('2026-11-10') ||
            String(x.effective_at).startsWith('2026-11-10')),
      ),
  },
  {
    id: 'unrelated_numeric_attribute',
    input: '我家的路由器型号是AX3000，书房面积是十二平方米。',
    expect: '技术型号与生活数值，不是项目报价',
    assess: (fs) => has(fs, /AX3000/i) && has(fs, /十二|12/, /书房|平方/),
  },
  {
    id: 'negated_relation',
    input: '韩梅不是我的同事，只是我大学时的同学。',
    expect: '保留同学关系，不捏造同事',
    assess: (fs) =>
      has(fs, /韩梅/, /同学/) &&
      !fs.some((x) => /同事/.test(x.value) && !/不|非/.test(x.value + x.qualifiers + x.predicate)),
  },
  {
    id: 'temporary_operation',
    input: '再说一次，然后把这句话复制到剪贴板。',
    expect: '零条长期事实',
    assess: (fs) => fs.length === 0,
  },
];
async function longitudinal(name: string, fn: (u: string) => Promise<void>) {
  const u = await f.user(),
    start = Date.now();
  try {
    await fn(u.id);
    report.longitudinal.push({
      name,
      ok: true,
      ms: Date.now() - start,
      facts: await current(u.id),
    });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.longitudinal.push({
      name,
      ok: false,
      error: safeError(e, config),
      facts: await current(u.id),
    });
    console.log(`FAIL ${name}: ${safeError(e, config)}`);
  }
}
try {
  assert(config.GMI_API_KEY, 'GMI_API_KEY required');
  let cursor = 0;
  const worker = async () => {
    while (cursor < cases.length) {
      const item = cases[cursor++],
        u = await f.user(),
        start = Date.now();
      try {
        await extract(u.id, item.input);
        const facts = await current(u.id),
          ok = item.assess(facts);
        report.cases.push({ ...item, assess: undefined, ok, ms: Date.now() - start, facts });
        console.log(`${ok ? 'PASS' : 'FAIL'} ${item.id}`);
      } catch (e) {
        report.cases.push({
          id: item.id,
          input: item.input,
          expect: item.expect,
          ok: false,
          error: safeError(e, config),
        });
        console.log(`FAIL ${item.id}: ${safeError(e, config)}`);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  await longitudinal(
    'Semantic role equivalents reinforce one fact without lexical substring rules',
    async (u) => {
      await extract(u, '陈总是LOL项目的负责人。', '2026-11-01T08:00:00Z');
      await extract(u, 'LOL项目一直由陈总负责。', '2026-11-02T08:00:00Z');
      const fs = (await current(u)).filter((x) => /陈总/.test(joined(x)) && /LOL/.test(joined(x)));
      assert.equal(fs.length, 1);
      assert(fs[0].evidence_count >= 2);
    },
  );
  await longitudinal(
    'An explicit residence change replaces only the selected previous location',
    async (u) => {
      await extract(u, '我目前在南京长期居住。', '2026-11-01T08:00:00Z');
      await extract(u, '我从今天开始搬到成都常住，已经不住南京了。', '2026-11-10T08:00:00Z');
      const fs = await current(u);
      assert(has(fs, /成都/));
      assert(!fs.some((x) => /南京/.test(x.value) && !/不|原|曾/.test(x.value + x.qualifiers)));
      assert(
        (await memory.list(db, u, { mode: 'timeline' })).some((x) => x.status === 'superseded'),
      );
    },
  );
  await longitudinal(
    'Multiple interests coexist and a partial update preserves the unaffected member',
    async (u) => {
      await extract(u, '我的爱好有跑步和摄影。', '2026-11-01T08:00:00Z');
      await extract(u, '我还喜欢游泳。', '2026-11-02T08:00:00Z');
      await extract(
        u,
        '我现在不再跑步了，改成骑车，摄影和游泳还是喜欢的。',
        '2026-11-10T08:00:00Z',
      );
      const fs = await current(u);
      assert(has(fs, /摄影/) && has(fs, /游泳/) && has(fs, /骑车/));
      assert(
        !fs.some((x) => /跑步/.test(x.value) && !/不|停止|原|过去/.test(x.value + x.qualifiers)),
      );
    },
  );
  await longitudinal(
    'Confirmation preserves the previous tentative version and a distinct budget goal',
    async (u) => {
      await extract(
        u,
        '远山计划对方提议三十万元，但我们还没确认。我希望控制在二十五万元。',
        '2026-11-01T08:00:00Z',
      );
      await extract(u, '远山计划最终预算双方已经确认，定为二十八万元。', '2026-11-10T08:00:00Z');
      const fs = await current(u);
      assert(fs.some((x) => /二十八|28/.test(x.value) && x.certainty === 'confirmed'));
      assert(fs.some((x) => /二十五|25/.test(x.value) && x.certainty === 'goal'));
      assert(!fs.some((x) => /三十|30/.test(x.value) && x.certainty === 'confirmed'));
    },
  );
  await longitudinal(
    'Cross-message pronouns use real original message evidence in semantic review',
    async (u) => {
      const a = await source(u, '陈总是LOL项目的负责人。', undefined, 'message');
      const b = await source(u, '这个就是陈总负责的。', undefined, 'message');
      const p = await review.prepare(u, {
        subject: '陈总',
        predicate: '职责',
        value: 'LOL项目负责人',
        person_name: '陈总',
        kind: 'relationship',
        supporting_evidence: [
          { source_id: b.id, quote: b.text },
          { source_id: a.id, quote: a.text },
        ],
      });
      const [d] = await review.decide(u, [p], 'chat-evaluation', new AbortController().signal);
      const result = await db.tx((c) => review.apply(c, u, p.id, d));
      assert(result.fact);
      assert.equal(result.fact.source_refs.length, 2);
    },
  );
  await longitudinal(
    'The real compaction worker extracts original-message relations and excludes reminder fragments',
    async (u) => {
      const a = await source(u, '周宁是我的室友，平时我更习惯用Linux。', undefined, 'message');
      const b = await source(u, '明天19点吃饭，大约两小时，提前提醒我。', undefined, 'message');
      await db.query(
        'INSERT INTO bot_state(user_id,memory_epoch) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING',
        [u],
      );
      const id = await db.tx((c) =>
        enqueueMemoryJob(c, u, 'compaction', 'real-generic-compaction', {
          source_ids: [a.id, b.id],
          memory_epoch: 0,
        }),
      );
      await jobs.process(id);
      const row = (await db.query('SELECT * FROM memory_jobs WHERE id=$1', [id])).rows[0];
      assert.equal(row.status, 'succeeded', row.last_error);
      const fs = await current(u);
      assert(has(fs, /周宁/, /室友/) && has(fs, /Linux/i));
      assert(!fs.some((x) => /19点|两小时|提前提醒/.test(x.value)));
    },
  );
} finally {
  jobs.stop();
  report.model_runs = (
    await db.query(
      'SELECT entrypoint,phase,status,sum(requests)::int AS requests,sum(input_tokens)::int AS input_tokens,sum(output_tokens)::int AS output_tokens FROM memory_model_runs GROUP BY entrypoint,phase,status',
    )
  ).rows;
  report.summary = {
    cases: report.cases.length,
    passed: report.cases.filter((x: any) => x.ok).length,
    longitudinal: report.longitudinal.length,
    longitudinal_passed: report.longitudinal.filter((x: any) => x.ok).length,
    negative_cases: report.cases.filter(
      (x: any) =>
        x.expect?.includes('零条') || ['question_only', 'hypothetical', 'opt_out'].includes(x.id),
    ).length,
    false_positive_cases: report.cases.filter(
      (x: any) =>
        !x.ok &&
        (x.expect?.includes('零条') || ['question_only', 'hypothetical', 'opt_out'].includes(x.id)),
    ).length,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/memory-generic-live.json', JSON.stringify(report, null, 2));
  await writeFile(
    `test-results/memory-generic-live-${report.at.replace(/[:.]/g, '-')}.json`,
    JSON.stringify(report, null, 2),
  );
  await f.close();
  console.log(JSON.stringify(report.summary));
  if (report.summary.passed !== cases.length || report.summary.longitudinal_passed !== 6)
    process.exitCode = 1;
}
