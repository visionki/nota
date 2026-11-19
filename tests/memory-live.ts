/** Real-model memory evaluation in an isolated database, using synthetic text only. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { RecordingAnalyzer, withEvidence } from '../src/server/recording-analysis.js';
import { MemoryService } from '../src/server/memory.js';
import { sourceDocument, saveChunks } from '../src/server/sources.js';
const fixture = await testDatabase(),
  { db } = fixture,
  config = loadConfig(),
  memory = new MemoryService();
const baseline = JSON.parse(
  (await readFile('tests/fixtures/memory-baseline.json', 'utf8')).replace(/^\uFEFF/, ''),
);
const report: any = {
  at: new Date().toISOString(),
  model: config.GMI_MODEL,
  scope:
    'Synthetic Chinese text → real GMI extraction → production evidence validation/persistence → recall. No ASR or complete conversational Agent evaluation.',
  cases: [],
  longitudinal: [],
  traces: [],
  analysis_calls: 0,
  model_requests: 0,
  total_tokens: 0,
};

function assess(test: any) {
  const facts = test.persisted_facts ?? [],
    people = test.persisted_people ?? [],
    candidates = test.persisted_candidates ?? [],
    active = facts.filter((f: any) => f.status === 'active');
  const quote = (amount: string) =>
    active.some(
      (f: any) =>
        f.subject === '青禾项目' &&
        /报价|价格/.test(f.predicate) &&
        new RegExp(amount).test(f.value),
    );
  switch (test.id) {
    case 'simple_quote':
      return quote('8.6|八点六');
    case 'negation_and_correction':
      return (
        quote('11.6|十一点六') &&
        !active.some((f: any) => f.subject === '王经理' && f.value === '是')
      );
    case 'same_name_two_organizations':
      return (
        candidates.some((x: any) => x.organization === '甲公司') &&
        candidates.some((x: any) => x.organization === '乙公司') &&
        candidates.every((x: any) => !x.comparison?.changed_values?.length)
      );
    case 'question_and_uncertainty':
      return !active.length && !people.length;
    case 'third_party_promise':
      return (
        test.result.actions.some((a: any) => a.actor === 'self' && /核对.*附件/.test(a.title)) &&
        !test.result.actions.some((a: any) => a.actor === 'self' && /发.*合同/.test(a.title))
      );
    case 'known_recording_relative_time':
      return facts.some((f: any) => String(f.effective_date ?? '').startsWith('2026-11-09'));
    case 'unknown_recording_relative_time':
      return facts.every((f: any) => !f.effective_at && !f.effective_date);
    case 'chat_memory_opt_out':
      return !facts.length && !people.length;
    case 'hypothetical_relation':
      return !active.length && !people.length;
    case 'multiple_people_shared_quote':
      return (
        people.some((p: any) => p.name === '王经理') && people.some((p: any) => p.name === '李经理')
      );
    default:
      return false;
  }
}
async function extract(
  userId: string,
  text: string,
  options: { when?: string | null; kind?: 'recording' | 'message'; instruction?: string } = {},
) {
  const id = randomUUID(),
    kind = options.kind ?? 'recording';
  if (kind === 'message')
    await db.query(
      "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,$5)",
      [id, userId, text, randomUUID(), options.when ?? new Date().toISOString()],
    );
  else {
    const op = randomUUID();
    await db.query(
      "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status,executor) VALUES($1,$2,$3,'live-evaluation','recording',$4,'succeeded','recording')",
      [
        op,
        userId,
        randomUUID(),
        {
          recording_id: id,
          instruction: options.instruction ?? '整理便签并提取有原文证据的重要记忆',
        },
      ],
    );
    await db.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,recorded_at,recorded_timezone,status) VALUES($1,$2,$3,'记忆效果评测',$4,'synthetic.wav','audio/wav',100,1,$5,1,$6,'Asia/Shanghai','ready')",
      [id, userId, op, randomUUID(), text, options.when ?? null],
    );
  }
  const source = await sourceDocument(db, userId, kind, id),
    chunks = await saveChunks(db, userId, source);
  const analyzer = new RecordingAnalyzer(config, (usage) => {
    report.total_tokens += Number(usage.total_tokens ?? 0);
  });
  const start = Date.now();
  report.analysis_calls++;
  let result;
  try {
    result = await analyzer.analyze(
      source,
      source.instruction ?? '整理来源记忆，遵守用户限定范围。',
      new AbortController().signal,
    );
  } finally {
    report.model_requests += analyzer.requestAttempts;
  }
  const prepared = withEvidence(source, chunks, result);
  const decisions = await db.tx((c) => memory.ingest(c, userId, source, prepared.facts));
  const trace = {
    input: text,
    ms: Date.now() - start,
    result,
    decisions,
    evidence_valid: !prepared.memory_rejections.length,
  };
  report.traces.push({ owner: userId, ...trace });
  return trace;
}
async function snapshot(userId: string) {
  return {
    persisted_facts: (
      await db.query(
        'SELECT subject,predicate,value,scope,kind,slot_key,effective_at,effective_date::text AS effective_date,person_id,status FROM facts WHERE user_id=$1',
        [userId],
      )
    ).rows,
    persisted_people: (
      await db.query('SELECT name,organization,identity_confirmed FROM people WHERE user_id=$1', [
        userId,
      ])
    ).rows,
    persisted_candidates: (
      await db.query(
        'SELECT subject,predicate,value,person_name,organization,status,comparison FROM memory_candidates WHERE user_id=$1',
        [userId],
      )
    ).rows,
  };
}
async function longitudinal(name: string, run: (userId: string) => Promise<boolean>) {
  const u = await fixture.user(),
    start = Date.now();
  try {
    const ok = await run(u.id);
    report.longitudinal.push({
      name,
      ok,
      owner: u.id,
      ms: Date.now() - start,
      ...(await snapshot(u.id)),
    });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  } catch (error) {
    report.longitudinal.push({ name, ok: false, error: safeError(error, config) });
    console.log(`FAIL ${name}`);
  }
}
try {
  if (!config.GMI_API_KEY) throw new Error('GMI_API_KEY required for real memory evaluation');
  let next = 0;
  const worker = async () => {
    while (next < baseline.cases.length) {
      const test = baseline.cases[next++],
        u = await fixture.user();
      try {
        const result = await extract(u.id, test.input, {
          when: test.recorded_at,
          kind: test.id === 'chat_memory_opt_out' ? 'message' : 'recording',
        });
        const evaluated = { id: test.id, ...result, ...(await snapshot(u.id)) };
        const ok = assess(evaluated);
        report.cases.push({ ...evaluated, ok, baseline_ok: assess(test) });
        console.log(`${ok ? 'PASS' : 'FAIL'} real model: ${test.id}`);
      } catch (error) {
        report.cases.push({
          id: test.id,
          ok: false,
          baseline_ok: assess(test),
          error: safeError(error, config),
        });
        console.log(`FAIL real model: ${test.id}`);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  await longitudinal(
    'Explicit quote update returns the new current value and both historical values',
    async (u) => {
      await extract(u, '青禾项目的报价是8.6万元。', { when: '2026-11-01T08:00:00Z' });
      await extract(u, '青禾项目的报价现在改为9万元，之前的报价作废。', {
        when: '2026-11-10T08:00:00Z',
      });
      const current = await memory.list(db, u, { query: '青禾项目' }),
        history = await memory.list(db, u, { query: '青禾项目', mode: 'timeline' });
      return (
        current.some((f) => /9万|九万/.test(f.value)) &&
        !current.some((f) => /8.6|八点六/.test(f.value)) &&
        history.some((f) => f.status === 'superseded')
      );
    },
  );
  await longitudinal('Preference correction updates bounded core context', async (u) => {
    await extract(u, '我喝茶更喜欢红茶。', { kind: 'message', when: '2026-11-01T08:00:00Z' });
    await extract(u, '我的喝茶偏好改为绿茶，以后不再选红茶。', {
      kind: 'message',
      when: '2026-11-10T08:00:00Z',
    });
    const core = await memory.context(db, u);
    return (
      core.items.some((f) => f.value.includes('绿茶')) &&
      !core.items.some((f) => f.value === '红茶')
    );
  });
  await longitudinal('Late historical recordings do not overwrite a newer quote', async (u) => {
    await extract(u, '青禾项目的报价现在是9万元。', { when: '2026-11-10T08:00:00Z' });
    await extract(u, '青禾项目的报价改为8.6万元。', { when: '2026-11-01T08:00:00Z' });
    const current = await memory.list(db, u, { query: '青禾项目' });
    return (
      current.some((f) => /9万|九万/.test(f.value)) &&
      !current.some((f) => /8.6|八点六/.test(f.value))
    );
  });
  await longitudinal(
    'Independent tax conditions coexist without automatic replacement',
    async (u) => {
      await extract(u, '青禾项目含税报价8.6万元，不含税报价8万元。这是两种不同条件。', {
        when: '2026-11-10T08:00:00Z',
      });
      const current = await memory.list(db, u, { query: '青禾项目' });
      return (
        current.some((f) => /8.6|八点六/.test(f.value)) &&
        current.some((f) => /^8万|^八万/.test(f.value))
      );
    },
  );
  await longitudinal('Forgetting survives a fresh extraction of the same preference', async (u) => {
    await extract(u, '我喜欢喝红茶。', { kind: 'message' });
    const before = await memory.list(db, u);
    if (!before.length) return false;
    for (const f of before) await db.tx((c) => memory.forget(c, u, f.id));
    await extract(u, '我喜欢喝红茶。', { kind: 'message' });
    return !(await memory.list(db, u, { mode: 'history' })).length;
  });
  await longitudinal(
    'Decayed memories leave core context while explicit history retains their source',
    async (u) => {
      await extract(u, '我喜欢喝红茶。', { kind: 'message' });
      const before = await memory.list(db, u);
      if (!before.length) return false;
      await db.query(
        "UPDATE facts SET last_reinforced_at=now()-interval '900 days' WHERE user_id=$1",
        [u],
      );
      await db.tx((c) => memory.maintain(c, u));
      return (
        !(await memory.context(db, u)).items.length &&
        (await memory.list(db, u, { mode: 'history' })).length > 0
      );
    },
  );
} catch (error) {
  report.error = safeError(error, config);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  report.summary = {
    baseline_scenarios_passed: report.cases.filter((x: any) => x.baseline_ok).length,
    baseline_scenarios_total: baseline.cases.length,
    scenarios_passed: report.cases.filter((x: any) => x.ok).length,
    scenarios_total: report.cases.length,
    longitudinal_passed: report.longitudinal.filter((x: any) => x.ok).length,
    longitudinal_total: report.longitudinal.length,
    evidence_valid: report.cases.filter((x: any) => x.evidence_valid).length,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/memory-live.json', JSON.stringify(report, null, 2));
  await writeFile(
    `test-results/memory-live-${report.at.replace(/[:.]/g, '-')}.json`,
    JSON.stringify(report, null, 2),
  );
  await fixture.close();
  console.log(JSON.stringify(report.summary));
}
if (report.cases.some((x: any) => !x.ok) || report.longitudinal.some((x: any) => !x.ok))
  process.exitCode = 1;
