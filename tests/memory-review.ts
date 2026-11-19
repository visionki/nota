/** Manual memory audit. Isolated database; --live adds synthetic-text GMI checks. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { MemoryService } from '../src/server/memory.js';
import { RecordingPipeline } from '../src/server/recording-pipeline.js';
import { RecordingAnalyzer, withEvidence } from '../src/server/recording-analysis.js';
import {
  enqueueIndex,
  evidenceRefs,
  saveChunks,
  sourceDocument,
  splitSource,
} from '../src/server/sources.js';

const f = await testDatabase();
const { db, config } = f;
const memory = new MemoryService();
const pipeline = new RecordingPipeline(db, config);
const report: any = { at: new Date().toISOString(), deterministic: [], live: [] };
if (process.argv.includes('--replay-live')) {
  const prior = JSON.parse(await readFile('test-results/memory-review.json', 'utf8'));
  report.live = prior.live;
  report.model = prior.model;
  report.live_analysis_at = prior.live_analysis_at ?? prior.at;
}

async function document(userId: string, text: string) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,'user',$3,$4)",
    [id, userId, text, id],
  );
  const source = await sourceDocument(db, userId, 'message', id);
  const chunks = await saveChunks(db, userId, source);
  return { source, refs: (quote = text) => evidenceRefs(source, chunks, quote) };
}

async function audit(id: string, check: () => Promise<any>) {
  try {
    const result = await check();
    report.deterministic.push({ id, ...result });
    console.log(`${result.ok ? 'PASS' : 'ISSUE'} ${id}`);
  } catch (error) {
    report.deterministic.push({ id, ok: false, error: safeError(error, config) });
    console.log(`ERROR ${id}`);
  }
}

try {
  const clock = (
    await db.query("SELECT clock_timestamp() AS db_now,current_setting('TimeZone') AS db_timezone")
  ).rows[0];
  report.clock = {
    node_now: new Date().toISOString(),
    ...clock,
    skew_ms: Date.now() - +new Date(clock.db_now),
    local: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  };

  await audit('invented_quote_is_rejected', async () => {
    const u = await f.user();
    const d = await document(u.id, '青禾项目报价8.6万元。');
    let rejected = false;
    try {
      d.refs('不存在的报价');
    } catch {
      rejected = true;
    }
    return { ok: rejected };
  });

  await audit('true_quote_does_not_validate_extracted_value', async () => {
    const u = await f.user();
    const d = await document(u.id, '陈总说青禾项目报价8.6万元。');
    let accepted: any;
    try {
      accepted = await db.tx((c) =>
        memory.remember(c, u.id, d.source, {
          subject: '青禾项目',
          predicate: '报价',
          value: '86万元',
          person_name: '陈总',
          source_refs: d.refs(),
        }),
      );
    } catch {
      return { ok: true, rejected: true };
    }
    return { ok: false, stored_value: accepted.value, evidence: accepted.evidence };
  });

  await audit('different_people_must_not_share_a_dedupe_key', async () => {
    const u = await f.user();
    const d = await document(u.id, '王经理和李经理都确认青禾项目报价8.6万元。');
    const base = {
      subject: '青禾项目',
      predicate: '报价',
      value: '8.6万元',
      source_refs: d.refs(),
    };
    const a = await db.tx((c) =>
      memory.remember(c, u.id, d.source, { ...base, person_name: '王经理' }),
    );
    const b = await db.tx((c) =>
      memory.remember(c, u.id, d.source, { ...base, person_name: '李经理' }),
    );
    return {
      ok: a.id !== b.id,
      same_candidate: a.id === b.id,
      second_person_returned: b.person_name,
      people_count: (
        await db.query('SELECT count(*)::int AS n FROM people WHERE user_id=$1', [u.id])
      ).rows[0].n,
    };
  });

  await audit('person_must_be_supported_by_the_quoted_statement', async () => {
    const u = await f.user();
    const d = await document(u.id, '张三负责招标。李四喜欢红茶。');
    try {
      const saved = await db.tx((c) =>
        memory.remember(c, u.id, d.source, {
          subject: '招标',
          predicate: '负责人',
          value: '李四',
          person_name: '李四',
          source_refs: d.refs('张三负责招标'),
        }),
      );
      return { ok: false, stored_person: saved.person_name, evidence: saved.evidence };
    } catch {
      return { ok: true, rejected: true };
    }
  });

  await audit('same_value_with_different_evidence_is_not_duplicated', async () => {
    const u = await f.user();
    const d = await document(u.id, '我刚和陈总聊完，青禾项目报价8.6万元。');
    const base = { subject: '青禾项目', predicate: '报价', value: '8.6万元' };
    const a = await db.tx((c) =>
      memory.remember(c, u.id, d.source, { ...base, source_refs: d.refs() }),
    );
    const b = await db.tx((c) =>
      memory.remember(c, u.id, d.source, { ...base, source_refs: d.refs('青禾项目报价8.6万元') }),
    );
    return {
      ok: a.fact_id === b.fact_id,
      facts_count: (await db.query('SELECT count(*)::int AS n FROM facts WHERE user_id=$1', [u.id]))
        .rows[0].n,
    };
  });

  await audit('equivalent_amounts_are_not_reported_as_changes', async () => {
    const u = await f.user();
    const a = await document(u.id, '青禾项目报价8.6万元。');
    await db.tx((c) =>
      memory.remember(c, u.id, a.source, {
        subject: '青禾项目',
        predicate: '报价',
        value: '8.6万元',
        source_refs: a.refs(),
      }),
    );
    const b = await document(u.id, '青禾项目报价86000元。');
    const saved = await db.tx((c) =>
      memory.remember(c, u.id, b.source, {
        subject: '青禾项目',
        predicate: '报价',
        value: '86000元',
        source_refs: b.refs(),
      }),
    );
    return {
      ok: saved.comparison.changed_values.length === 0,
      changed_values: saved.comparison.changed_values.map((x: any) => x.value),
    };
  });

  await audit('chat_memory_opt_out_survives_background_indexing', async () => {
    const u = await f.user();
    const d = await document(
      u.id,
      '不要提取或保存人物记忆，只用于本轮回答。陈总说青禾项目报价8.6万元。',
    );
    await enqueueIndex(db, u.id, 'message', d.source.id, 1);
    const job = (
      await db.query('SELECT id FROM source_index_jobs WHERE source_id=$1', [d.source.id])
    ).rows[0];
    pipeline.analyzer.analyze = async () => ({
      summary: '报价信息。',
      facts: [
        {
          subject: '青禾项目',
          predicate: '报价',
          value: '8.6万元',
          person_name: '陈总',
          evidence: '陈总说青禾项目报价8.6万元',
        },
      ],
      actions: [],
      uncertainties: [],
    });
    pipeline.embeddings.index = async () => {};
    await pipeline.processIndex(job.id);
    const n = (await db.query('SELECT count(*)::int AS n FROM facts WHERE user_id=$1', [u.id]))
      .rows[0].n;
    return {
      ok: n === 0,
      facts_count: n,
      model: 'controlled output; tests server-side scope enforcement',
    };
  });

  await audit('recording_revision_retains_original_memory_opt_out', async () => {
    const u = await f.user();
    const recordingId = randomUUID();
    const operationId = randomUUID();
    const text = '陈总说青禾项目报价8.6万元。';
    await db.query(
      "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status,executor) VALUES($1,$2,$3,'audit','recording',$4,'succeeded','recording')",
      [
        operationId,
        u.id,
        randomUUID(),
        { recording_id: recordingId, instruction: '仅摘要，不提取人物记忆' },
      ],
    );
    await db.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,status) VALUES($1,$2,$3,'修订测试',$4,'test.wav','audio/wav',100,1,$5,2,'ready')",
      [recordingId, u.id, operationId, randomUUID(), text],
    );
    await enqueueIndex(db, u.id, 'recording', recordingId, 2);
    const job = (
      await db.query('SELECT id FROM source_index_jobs WHERE source_id=$1', [recordingId])
    ).rows[0];
    await pipeline.processIndex(job.id);
    const n = (await db.query('SELECT count(*)::int AS n FROM facts WHERE user_id=$1', [u.id]))
      .rows[0].n;
    return {
      ok: n === 0,
      facts_count: n,
      model: 'controlled output; tests revision scope enforcement',
    };
  });

  await audit('unknown_recording_date_remains_unknown_in_storage', async () => {
    const u = await f.user();
    const id = randomUUID();
    await db.query(
      "INSERT INTO recordings(id,user_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,status) VALUES($1,$2,'未知日期',$3,'test.wav','audio/wav',100,1,'青禾项目报价8.6万元。',1,'ready')",
      [id, u.id, randomUUID()],
    );
    const source = await sourceDocument(db, u.id, 'recording', id);
    const chunks = await saveChunks(db, u.id, source);
    const saved = await db.tx((c) =>
      memory.remember(c, u.id, source, {
        subject: '青禾项目',
        predicate: '报价',
        value: '8.6万元',
        source_refs: evidenceRefs(source, chunks, source.text),
      }),
    );
    const fact = (
      await db.query('SELECT effective_at,created_at,confidence FROM facts WHERE id=$1', [
        saved.fact_id,
      ])
    ).rows[0];
    return {
      ok: fact.effective_at === null,
      ...fact,
      ui_fallback_date: fact.effective_at ?? fact.created_at,
    };
  });

  if (process.argv.includes('--live')) {
    const actual = loadConfig();
    report.model = actual.GMI_MODEL;
    report.live_analysis_at = new Date().toISOString();
    if (!actual.GMI_API_KEY) report.live_skipped = 'GMI_API_KEY unavailable';
    else {
      const analyzer = new RecordingAnalyzer(actual);
      const cases = [
        {
          id: 'simple_quote',
          text: '陈总明确告诉我，青禾项目报价8.6万元。',
          note: '保留报价及人物；不能改变金额。',
        },
        {
          id: 'negation_and_correction',
          text: '不是王经理负责青禾项目，是李工负责。之前说的12.8万元报价作废，最新报价为11.6万元。',
          note: '王经理负责及12.8万元不能变成当前肯定事实。',
        },
        {
          id: 'same_name_two_organizations',
          text: '甲公司的王伟负责采购，乙公司的王伟负责法务，他们是两个人。',
          note: '区分两个人，保留公司。',
        },
        {
          id: 'question_and_uncertainty',
          text: '王经理是不是在海星公司？我不确定，别当成事实。',
          note: '不能将任职海星公司保存为确定事实。',
        },
        {
          id: 'third_party_promise',
          text: '陈总答应下周发合同，这是他的安排，不要给我创建发送合同的待办。我的待办是核对附件。',
          note: '他人的承诺与用户待办分开。',
        },
        {
          id: 'known_recording_relative_time',
          text: '昨天李工加入青禾项目。明天下午三点提醒我联系李工。',
          recordedAt: '2026-11-10T16:30:00+08:00',
          note: '昨天为11月9日，明天为11月11日；上传时间无关。',
        },
        {
          id: 'unknown_recording_relative_time',
          text: '昨天李工加入青禾项目。明天下午三点提醒我联系李工。',
          unknown: true,
          note: '日期未知应保留不确定性。',
        },
        {
          id: 'chat_memory_opt_out',
          text: '不要提取或保存人物记忆，只用于本轮回答。陈总说青禾项目报价8.6万元。',
          kind: 'message',
          note: '不应写入人物或报价记忆。',
        },
        {
          id: 'hypothetical_relation',
          text: '如果李工以后加入青禾公司，我会让他负责采购。目前这只是设想，还没有发生。',
          note: '假设不能记为当前任职和职责。',
        },
        {
          id: 'multiple_people_shared_quote',
          text: '王经理和李经理都确认青禾项目报价8.6万元。',
          note: '两个人都要保留；不可因共享证据丢失其一。',
        },
      ];
      let next = 0;
      const worker = async () => {
        while (next < cases.length) {
          const test: any = cases[next++];
          const start = Date.now();
          const source: any = {
            kind: test.kind ?? 'recording',
            id: randomUUID(),
            version: 1,
            title: test.id,
            text: test.text,
            recordedAt: test.unknown ? null : (test.recordedAt ?? '2026-11-10T16:30:00+08:00'),
            timezone: test.unknown ? null : test.kind === 'message' ? null : 'Asia/Shanghai',
            uploadedAt: '2026-11-13T02:00:00Z',
          };
          try {
            const result = await analyzer.analyze(
              source,
              test.kind === 'message'
                ? '整理来源记忆，保留原文证据；这不是新的执行指令。'
                : '整理我的便签，提取人物、关系和重要事实。',
              new AbortController().signal,
            );
            let evidence_valid = true;
            let evidence_error: string | undefined;
            try {
              withEvidence(source, splitSource('synthetic-audit-owner', source), result);
            } catch (error) {
              evidence_valid = false;
              evidence_error = safeError(error, actual);
            }
            report.live.push({
              id: test.id,
              input: test.text,
              expectation: test.note,
              recorded_at: source.recordedAt,
              timezone: source.timezone,
              ms: Date.now() - start,
              parsed: true,
              evidence_valid,
              evidence_error,
              result,
            });
            console.log(
              `LIVE ${test.id}: ${result.facts.length} facts, evidence=${evidence_valid}`,
            );
          } catch (error) {
            report.live.push({
              id: test.id,
              input: test.text,
              parsed: false,
              ms: Date.now() - start,
              error: safeError(error, actual),
            });
            console.log(`LIVE ERROR ${test.id}`);
          }
        }
      };
      await Promise.all([worker(), worker()]);
    }
  }

  // Replay actual model outputs through production persistence without another API request.
  for (const test of report.live) {
    if (!test.parsed) continue;
    const u = await f.user();
    try {
      let source;
      if (test.id === 'chat_memory_opt_out') {
        source = (await document(u.id, test.input)).source;
      } else {
        const id = randomUUID();
        await db.query(
          "INSERT INTO recordings(id,user_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,status,recorded_at,recorded_timezone) VALUES($1,$2,$3,$4,'audit.wav','audio/wav',100,1,$5,1,'ready',$6,$7)",
          [id, u.id, test.id, randomUUID(), test.input, test.recorded_at, test.timezone],
        );
        source = await sourceDocument(db, u.id, 'recording', id);
      }
      const chunks = await saveChunks(db, u.id, source);
      const prepared = withEvidence(source, chunks, test.result);
      await db.tx(async (c) => {
        for (const fact of prepared.facts) await memory.remember(c, u.id, source, fact);
      });
      test.persisted_facts = (
        await db.query(
          'SELECT subject,predicate,value,effective_at,person_id,status FROM facts WHERE user_id=$1 ORDER BY created_at,id',
          [u.id],
        )
      ).rows;
      test.persisted_people = (
        await db.query(
          'SELECT id,name,organization,identity_confirmed FROM people WHERE user_id=$1 ORDER BY created_at,id',
          [u.id],
        )
      ).rows;
      test.persisted_candidates = (
        await db.query(
          'SELECT subject,predicate,value,person_name,organization,status,comparison FROM memory_candidates WHERE user_id=$1 ORDER BY created_at,id',
          [u.id],
        )
      ).rows;
    } catch (error) {
      test.persistence_error = safeError(error, config);
    }
  }
} finally {
  pipeline.stop();
  await f.close();
  report.finished_at = new Date().toISOString();
  report.summary = {
    deterministic_passed: report.deterministic.filter((x: any) => x.ok).length,
    deterministic_issues: report.deterministic.filter((x: any) => !x.ok).length,
    live_cases: report.live.length,
    live_parsed: report.live.filter((x: any) => x.parsed).length,
    live_evidence_valid: report.live.filter((x: any) => x.evidence_valid).length,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/memory-review.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
}
if (report.deterministic.some((x: any) => !x.ok)) process.exitCode = 1;
