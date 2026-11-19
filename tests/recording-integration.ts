/** Real PostgreSQL, API, leases and business tools; provider responses are controlled. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase, wav } from './helpers.js';
import { Operations, quotaDay } from '../src/server/quota.js';
import type { Queue } from '../src/server/queue.js';
import { RecordingPipeline } from '../src/server/recording-pipeline.js';
import { joinWindow, dispatchWindows, windowResults } from '../src/server/recording-windows.js';
import { Runtime } from '../src/server/runtime.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';
import {
  sourceDocument,
  saveChunks,
  evidenceRefs,
  readSource,
  verifyRefs,
  Embeddings,
} from '../src/server/sources.js';
import { MemoryService } from '../src/server/memory.js';
import { createApp } from '../src/server/app.js';
const f = await testDatabase(),
  { db, config } = f,
  ops = new Operations(db, config),
  pipeline = new RecordingPipeline(db, config);
// Controlled provider output for the new semantic comparison phase; retrieval,
// quotations, snapshots, leases and actual database writes remain production code.
pipeline.reviewer.decide = async (_u, proposals) =>
  proposals.map(() => ({
    action: 'ADD',
    target_ids: [],
    classification: 'durable',
    evidence_supported: true,
    reason: 'Controlled fixture supports an independent fact',
  }));
const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e) });
    throw e;
  }
}
async function upload(
  userId: string,
  text = '我记下青禾项目报价8.6万元。明天上午9点提醒我核对附件。',
  key = randomUUID(),
) {
  return db.tx(async (c) => {
    const op = await ops.create(
      userId,
      key,
      'recording',
      { recording_id: randomUUID(), instruction: '整理我的便签' },
      c,
    );
    const id = op.input.recording_id;
    await c.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,recorded_at,recorded_timezone,recording_time_source) VALUES($1,$2,$3,$4,$5,'fixture.wav','audio/wav',100,3,$6,1,$7,'Asia/Shanghai','provided')",
      [id, userId, op.id, '动态窗口录音', randomUUID(), text, new Date().toISOString()],
    );
    await c.query(
      "INSERT INTO recording_revisions(id,recording_id,user_id,version,transcript,source) VALUES($1,$2,$3,1,$4,'fixture')",
      [randomUUID(), id, userId, text],
    );
    const batch = await joinWindow(c, userId, op.id, id);
    return { op, id, batch, text };
  });
}
pipeline.analyzer.analyze = async (source) => ({
  summary: '项目报价已记下；有一项核对附件的提醒交办。',
  facts: [
    { subject: '青禾项目', predicate: '报价', value: '8.6万元', evidence: '青禾项目报价8.6万元' },
  ],
  actions: [
    {
      kind: 'reminder',
      title: '核对附件',
      evidence: '明天上午9点提醒我核对附件',
      actor: 'self',
      explicit: true,
      time_expression: '明天上午9点',
    },
  ],
  uncertainties: [],
});
async function sendAudio(
  app: Awaited<ReturnType<typeof createApp>>['app'],
  cookie: string,
  key = randomUUID(),
) {
  const form = new FormData();
  form.set('idempotency_key', key);
  form.set('title', '额度用完后上传的便签');
  form.set('file', new Blob([new Uint8Array(wav())], { type: 'audio/wav' }), 'memo.wav');
  const request = new Request('http://localhost/api/recordings', { method: 'POST', body: form });
  return app.inject({
    method: 'POST',
    url: '/api/recordings',
    headers: { cookie, 'content-type': request.headers.get('content-type')! },
    payload: Buffer.from(await request.arrayBuffer()),
  });
}
try {
  await check(
    'A rejected memory commit is isolated from the recording artifact and resumes through a durable memory-only job',
    async () => {
      const u = await f.user(),
        file = await upload(u.id),
        original = pipeline.reviewer.apply;
      pipeline.reviewer.apply = async () => {
        throw new Error('controlled memory commit failure');
      };
      try {
        await pipeline.process(file.op.id);
      } finally {
        pipeline.reviewer.apply = original;
      }
      const op = (await db.query('SELECT status FROM operations WHERE id=$1', [file.op.id]))
        .rows[0];
      assert.equal(op.status, 'succeeded');
      const artifact = (
        await db.query('SELECT * FROM recording_artifacts WHERE recording_id=$1', [file.id])
      ).rows[0];
      assert(artifact.summary);
      assert.match(artifact.payload.memory_error, /controlled memory commit failure/);
      assert.equal(
        (
          await db.query('SELECT count(*)::int AS n FROM candidate_actions WHERE artifact_id=$1', [
            artifact.id,
          ])
        ).rows[0].n,
        1,
      );
      const job = (
        await db.query("SELECT * FROM memory_jobs WHERE user_id=$1 AND entrypoint='recording'", [
          u.id,
        ])
      ).rows[0];
      assert.equal(job.status, 'queued');
      pipeline.memoryJobs.review.decide = pipeline.reviewer.decide;
      await pipeline.memoryJobs.process(job.id);
      assert.equal(
        (await db.query('SELECT status FROM memory_jobs WHERE id=$1', [job.id])).rows[0].status,
        'succeeded',
      );
      assert.equal((await new MemoryService().list(db, u.id)).length, 1);
      assert.equal(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM recording_artifacts WHERE recording_id=$1',
            [file.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'Exhausted uploads remain durable and playable without processing; concurrent workers reserve a restored credit once',
    async () => {
      const u = await f.user(),
        { app, auth, storage } = await createApp(config, db),
        cookie = `nota_session=${encodeURIComponent(app.signCookie(await auth.session(u.id)))}`;
      try {
        await db.query('INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,$2,$3)', [
          u.id,
          quotaDay(),
          config.FREE_DAILY_LIMIT,
        ]);
        const key = randomUUID(),
          first = await sendAudio(app, cookie, key),
          replay = await sendAudio(app, cookie, key);
        assert.equal(first.statusCode, 200, first.body);
        assert.equal(first.json().status, 'pending');
        assert.equal(first.json().batch_id, null);
        assert.equal(replay.json().replayed, true);
        assert.equal(replay.json().status, 'pending');
        assert.equal(replay.json().id, first.json().id);
        const { id, operation_id: operationId } = first.json(),
          record = (await db.query('SELECT * FROM recordings WHERE id=$1', [id])).rows[0];
        assert.deepEqual(await storage.get(record.storage_key), wav());
        const audio = await app.inject({ url: `/api/recordings/${id}/audio`, headers: { cookie } });
        assert.equal(audio.statusCode, 200);
        assert.deepEqual(audio.rawPayload, wav());
        const other = await f.user(),
          otherCookie = `nota_session=${encodeURIComponent(app.signCookie(await auth.session(other.id)))}`;
        assert.equal(
          (
            await app.inject({
              url: `/api/recordings/${id}/audio`,
              headers: { cookie: otherCookie },
            })
          ).statusCode,
          404,
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/operations/${operationId}/continue`,
              headers: { cookie },
              payload: { text: '开始处理' },
            })
          ).statusCode,
          409,
        );
        const queued: string[] = [],
          queue = { sendFile: async (id: string) => queued.push(id) } as unknown as Queue;
        await pipeline.tick(queue);
        await pipeline.process(operationId);
        assert(!queued.includes(operationId));
        assert.equal(
          (await db.query('SELECT attempts FROM operations WHERE id=$1', [operationId])).rows[0]
            .attempts,
          0,
        );
        assert.equal((await ops.usage(u.id)).reserved, 0);
        assert.equal(
          (await db.query('SELECT * FROM recording_batch_items WHERE user_id=$1', [u.id])).rowCount,
          0,
        );
        await db.query('UPDATE quota_buckets SET used=used-1 WHERE user_id=$1', [u.id]);
        await Promise.all([pipeline.tick(queue), pipeline.tick(queue), ops.resumeRecordings()]);
        assert.equal((await ops.usage(u.id)).reserved, 1);
        assert.equal((await ops.usage(u.id)).remaining, 0);
        assert.equal(
          (await db.query('SELECT * FROM quota_reservations WHERE operation_id=$1', [operationId]))
            .rowCount,
          1,
        );
        assert.equal(
          (
            await db.query('SELECT * FROM recording_batch_items WHERE operation_id=$1', [
              operationId,
            ])
          ).rowCount,
          1,
        );
        assert.equal((await sendAudio(app, cookie, key)).json().status, 'uploaded');
        const transcribe = pipeline.transcriber.transcribe;
        pipeline.transcriber.transcribe = async () => ({
          text: '我记下青禾项目报价8.6万元。明天上午9点提醒我核对附件。',
          segments: [],
          model: 'controlled-asr',
        });
        try {
          await pipeline.process(operationId);
          assert.equal(
            (await db.query('SELECT status FROM recordings WHERE id=$1', [id])).rows[0].status,
            'prepared',
          );
        } finally {
          pipeline.transcriber.transcribe = transcribe;
        }
      } finally {
        await app.close();
      }
    },
  );
  await check(
    'Daily reset resumes the oldest pending uploads within the Free limit; cancellation and Pro upgrade preserve reservations',
    async () => {
      const u = await f.user(),
        { app, auth } = await createApp(config, db),
        cookie = `nota_session=${encodeURIComponent(app.signCookie(await auth.session(u.id)))}`;
      try {
        await db.query('INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,$2,$3)', [
          u.id,
          quotaDay(),
          config.FREE_DAILY_LIMIT,
        ]);
        const files = [];
        for (let i = 0; i < config.FREE_DAILY_LIMIT + 3; i++) {
          const response = await sendAudio(app, cookie);
          assert.equal(response.statusCode, 200, response.body);
          files.push(response.json());
        }
        const cancelled = files.pop()!;
        await ops.cancel(u.id, cancelled.operation_id);
        await db.query('UPDATE quota_buckets SET quota_day=quota_day-1 WHERE user_id=$1', [u.id]);
        await Promise.all([ops.resumeRecordings(), ops.resumeRecordings()]);
        const states = (
          await db.query(
            'SELECT id,status FROM recordings WHERE user_id=$1 ORDER BY created_at,id',
            [u.id],
          )
        ).rows;
        assert.deepEqual(
          states.filter((r) => r.status === 'uploaded').map((r) => r.id),
          files.slice(0, config.FREE_DAILY_LIMIT).map((r) => r.id),
        );
        assert.equal(states.filter((r) => r.status === 'pending').length, 2);
        assert.equal((await ops.usage(u.id)).reserved, config.FREE_DAILY_LIMIT);
        assert.equal((await ops.usage(u.id)).used, 0);
        await db.query(
          "UPDATE subscriptions SET plan='pro',status='active',period_end=now()+interval '1 day' WHERE user_id=$1",
          [u.id],
        );
        await ops.resumeRecordings();
        await ops.resumeRecordings();
        assert.equal((await ops.usage(u.id)).reserved, config.FREE_DAILY_LIMIT + 2);
        assert.equal(
          (await db.query("SELECT * FROM recordings WHERE user_id=$1 AND status='pending'", [u.id]))
            .rowCount,
          0,
        );
        assert.equal(
          (await db.query('SELECT status FROM operations WHERE id=$1', [cancelled.operation_id]))
            .rows[0].status,
          'cancelled',
        );
        assert.equal(
          (
            await db.query('SELECT * FROM quota_reservations WHERE operation_id=$1', [
              cancelled.operation_id,
            ])
          ).rowCount,
          0,
        );
      } finally {
        await app.close();
      }
    },
  );
  await check(
    'In-flight recording plus five new uploads share one drained window and one durable activation',
    async () => {
      const u = await f.user();
      const first = await upload(u.id);
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        begun = new Promise<void>((r) => (started = r)),
        original = pipeline.analyzer.analyze;
      pipeline.analyzer.analyze = async (...args) => {
        started();
        await gate;
        return original(...args);
      };
      const run = pipeline.process(first.op.id);
      await begun;
      const five = await Promise.all(Array.from({ length: 5 }, () => upload(u.id)));
      assert(five.every((x) => x.batch === first.batch));
      await dispatchWindows(db, 100);
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rowCount,
        0,
      );
      release();
      await run;
      pipeline.analyzer.analyze = original;
      for (const item of five) await pipeline.process(item.op.id);
      assert.equal((await windowResults(db, u.id, first.batch)).length, 6);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM messages WHERE user_id=$1', [u.id])).rows[0]
          .n,
        0,
      );
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE id=$1",
        [first.batch],
      );
      await Promise.all(Array.from({ length: 12 }, () => dispatchWindows(db, 100)));
      const events = (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rows;
      assert.equal(events.length, 1);
      assert.equal((await ops.usage(u.id)).reserved, 6);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM operations WHERE user_id=$1 AND executor='agent'",
            [u.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    'A continuous backlog seals at ten; later items form the next window even while the first is processing',
    async () => {
      const u = await f.user();
      await db.query(
        "UPDATE subscriptions SET plan='pro',status='active',period_end=now()+interval '1 day' WHERE user_id=$1",
        [u.id],
      );
      const files: Awaited<ReturnType<typeof upload>>[] = [];
      for (let i = 0; i < 15; i++) files.push(await upload(u.id));
      assert(files.slice(0, 10).every((x) => x.batch === files[0].batch));
      assert(files.slice(10).every((x) => x.batch === files[10].batch));
      assert.notEqual(files[0].batch, files[10].batch);
      assert.equal(
        (await db.query('SELECT state FROM recording_batches WHERE id=$1', [files[0].batch]))
          .rows[0].state,
        'sealed',
      );
      for (const item of files) await pipeline.process(item.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE user_id=$1",
        [u.id],
      );
      await dispatchWindows(db, 100);
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rowCount,
        2,
      );
      assert.deepEqual(
        (
          await db.query(
            'SELECT count(*)::int AS n FROM recording_batch_items WHERE user_id=$1 GROUP BY batch_id ORDER BY n DESC',
            [u.id],
          )
        ).rows.map((r) => r.n),
        [10, 5],
      );
    },
  );
  await check(
    'Draining and accepting new input serialize: no lost file and never more than ten members',
    async () => {
      const u = await f.user(),
        one = await upload(u.id);
      await pipeline.process(one.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE id=$1",
        [one.batch],
      );
      const [, two] = await Promise.all([dispatchWindows(db, 100), upload(u.id)]);
      await pipeline.process(two.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE user_id=$1",
        [u.id],
      );
      await dispatchWindows(db, 100);
      const counts = (
        await db.query(
          "SELECT i.operation_id,count(*)::int AS n FROM recording_batch_items i JOIN recording_batches b ON b.id=i.batch_id WHERE i.user_id=$1 AND b.state='dispatched' GROUP BY i.operation_id",
          [u.id],
        )
      ).rows;
      assert.equal(counts.length, 2);
      assert(counts.every((r) => r.n === 1));
    },
  );
  await check(
    'Slow file analysis never holds the conversational actor lock or captures a new chat as steering',
    async () => {
      const u = await f.user(),
        file = await upload(u.id);
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        begun = new Promise<void>((r) => (started = r)),
        original = pipeline.analyzer.analyze;
      pipeline.analyzer.analyze = async (...args) => {
        started();
        await gate;
        return original(...args);
      };
      const pending = pipeline.process(file.op.id);
      await begun;
      const chat = await ops.submit(u.id, randomUUID(), '你好，请直接回答');
      assert.notEqual(chat.id, file.op.id);
      assert.equal(chat.steered, false);
      const runtime = new Runtime(db, config);
      runtime.agent.run = async () => ({
        text: '你好，录音仍在独立整理。',
        usage: 0,
        sessionPath: null,
        waiting: undefined,
      });
      await Promise.race([
        runtime.processUser(u.id),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Chat blocked by ASR')), 2500),
        ),
      ]);
      assert.equal(
        (await db.query('SELECT status FROM operations WHERE id=$1', [chat.id])).rows[0].status,
        'succeeded',
      );
      release();
      await pending;
      pipeline.analyzer.analyze = original;
    },
  );
  await check(
    'The bot receives summaries and source pointers, executes one sourced candidate, and settles inherited credits once',
    async () => {
      const u = await f.user(),
        files = [await upload(u.id), await upload(u.id)];
      for (const item of files) await pipeline.process(item.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE user_id=$1",
        [u.id],
      );
      await dispatchWindows(db, 100);
      const runtime = new Runtime(db, config);
      runtime.agent.run = async (ctx, prompt) => {
        const envelope = JSON.parse(prompt);
        assert.equal(envelope.recording, undefined);
        assert.equal(envelope.recording_batch.items.length, 2);
        assert(!prompt.includes('"transcript":'));
        assert(!prompt.includes('"source_text":'));
        const action = envelope.recording_batch.items[0].actions[0],
          tool = buildTools(ctx).find((t) => t.name === 'create_reminder')!;
        const a = await tool.execute('first', {
          title: '核对附件',
          remind_at: new Date(Date.now() + 864e5).toISOString(),
          candidate_id: action.candidate_id,
        });
        const b = await tool.execute('retry', {
          title: '核对附件',
          remind_at: new Date(Date.now() + 864e5).toISOString(),
          candidate_id: action.candidate_id,
        });
        assert.equal((a.details as any).id, (b.details as any).id);
        assert((a.details as any).source_refs.length);
        return {
          text: '两条便签整理完成，已设置一条提醒。',
          usage: 0,
          sessionPath: null,
          waiting: undefined,
        };
      };
      await runtime.processUser(u.id);
      assert.equal((await ops.usage(u.id)).used, 2);
      assert.equal((await ops.usage(u.id)).reserved, 0);
      assert.equal(
        (await db.query("SELECT * FROM messages WHERE user_id=$1 AND role='assistant'", [u.id]))
          .rowCount,
        1,
      );
      assert.equal(
        (await db.query('SELECT * FROM reminders WHERE user_id=$1', [u.id])).rowCount,
        1,
      );
      await dispatchWindows(db, 100);
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rowCount,
        1,
      );
    },
  );
  await check(
    'Partial failures reach terminal state, release only failed reservations and still produce one batch event',
    async () => {
      const u = await f.user(),
        good = await upload(u.id),
        bad = await upload(u.id);
      const original = pipeline.analyzer.analyze;
      pipeline.analyzer.analyze = async (source, ...args) => {
        if (source.id === bad.id) throw new Error('controlled provider failure');
        return original(source, ...args);
      };
      await pipeline.process(good.op.id);
      for (let i = 0; i < 3; i++) await pipeline.process(bad.op.id);
      pipeline.analyzer.analyze = original;
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE user_id=$1",
        [u.id],
      );
      await dispatchWindows(db, 100);
      const items = await windowResults(db, u.id, good.batch);
      assert.deepEqual(items.map((i) => i.state).sort(), ['failed', 'ready']);
      assert.equal((await ops.usage(u.id)).reserved, 1);
      assert.equal(
        (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rowCount,
        1,
      );
    },
  );
  await check(
    'Versioned chunk evidence survives edits; stale actions reject writing and other owners cannot read nearby text',
    async () => {
      const u = await f.user(),
        other = await f.user(),
        item = await upload(u.id);
      await pipeline.process(item.op.id);
      const source = await sourceDocument(db, u.id, 'recording', item.id, 1),
        chunks = await saveChunks(db, u.id, source),
        refs = evidenceRefs(source, chunks, '青禾项目报价8.6万元');
      assert.equal((await readSource(db, u.id, refs[0].chunk_id)).source_version, 1);
      await assert.rejects(() => readSource(db, other.id, refs[0].chunk_id));
      await db.query("UPDATE recordings SET transcript='已修订的内容',version=2 WHERE id=$1", [
        item.id,
      ]);
      assert.equal((await sourceDocument(db, u.id, 'recording', item.id, 1)).text, item.text);
      await assert.rejects(() => verifyRefs(db, u.id, refs, true), /原文已经修订/);
      await verifyRefs(db, u.id, refs);
      assert.equal((await readSource(db, u.id, refs[0].chunk_id)).chunks[0].text, item.text);
    },
  );
  await check(
    'Memory compares recording and chat sources; ambiguous same-name people need explicit confirmation',
    async () => {
      const u = await f.user(),
        item = await upload(u.id, '陈总说青禾项目报价8.6万元。明天上午9点提醒我核对附件。');
      const source = await sourceDocument(db, u.id, 'recording', item.id),
        chunks = await saveChunks(db, u.id, source),
        memory = new MemoryService();
      const first = await db.tx((c) =>
        memory.remember(c, u.id, source, {
          subject: '青禾项目',
          predicate: '报价',
          value: '8.6万元',
          person_name: '陈总',
          source_refs: evidenceRefs(source, chunks, '陈总说青禾项目报价8.6万元'),
        }),
      );
      const op = await ops.submit(u.id, randomUUID(), '陈总说青禾项目报价9万元。'),
        message = (
          await db.query("SELECT id FROM messages WHERE operation_id=$1 AND role='user'", [op.id])
        ).rows[0];
      const chat = await sourceDocument(db, u.id, 'message', message.id),
        chatChunks = await saveChunks(db, u.id, chat);
      const next = await db.tx((c) =>
        memory.remember(c, u.id, chat, {
          subject: '青禾项目',
          predicate: '报价',
          value: '9万元',
          person_name: '陈总',
          source_refs: evidenceRefs(chat, chatChunks, chat.text),
        }),
      );
      assert.equal(next.status, 'needs_identity');
      assert.equal(next.person_id, null);
      assert.equal(next.comparison.changed_values.length, 0);
      assert(next.comparison.possible_people.some((x: any) => x.id === first.person_id));
      await db.tx((c) =>
        memory.resolve(c, u.id, next.id, undefined, {
          name: '陈总',
          organization: '另一家公司',
          role: '另一位联系人',
        }),
      );
      const resolved = (await db.query('SELECT * FROM memory_candidates WHERE id=$1', [next.id]))
        .rows[0];
      assert.notEqual(resolved.person_id, first.person_id);
      assert.equal(resolved.status, 'resolved');
    },
  );
  await check(
    'pgvector stores model/dimension/source metadata and semantic search remains scoped to the owner',
    async () => {
      assert(
        (await db.query("SELECT 1 FROM pg_extension WHERE extname='vector'")).rowCount,
        'pgvector extension must be installed for this acceptance test',
      );
      const u = await f.user(),
        other = await f.user(),
        item = await upload(u.id);
      const source = await sourceDocument(db, u.id, 'recording', item.id);
      await saveChunks(db, u.id, source);
      const embeddings = new Embeddings(
        { ...config, OPENAI_API_KEY: 'controlled', EMBEDDING_DIMENSIONS: 256 },
        db,
      );
      embeddings.encode = async (texts) => texts.map(() => [1, ...Array(255).fill(0)]);
      await embeddings.index(u.id, source, new AbortController().signal);
      const result = await embeddings.search(u.id, '无关键词命中的语义提问');
      assert.equal(result.mode, 'hybrid');
      assert.equal(result.chunks[0].source_id, item.id);
      assert.equal(result.chunks[0].source_version, 1);
      assert.equal((await embeddings.search(other.id, '无关键词命中的语义提问')).chunks.length, 0);
    },
  );
  await check(
    'Batch Agent failure refunds original file reservations; API retry inherits and commits them once',
    async () => {
      const u = await f.user(),
        file = await upload(u.id);
      await pipeline.process(file.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE id=$1",
        [file.batch],
      );
      await dispatchWindows(db, 100);
      const batch = (await db.query('SELECT * FROM recording_batches WHERE id=$1', [file.batch]))
          .rows[0],
        runtime = new Runtime(db, config);
      runtime.agent.run = async () => {
        throw new Error('controlled permanent failure');
      };
      for (let i = 0; i < 3; i++) {
        await db.query("UPDATE operations SET updated_at=now()-interval '1 minute' WHERE id=$1", [
          batch.agent_operation_id,
        ]);
        await runtime.processUser(u.id);
      }
      assert.equal((await ops.usage(u.id)).reserved, 0);
      assert.equal((await ops.usage(u.id)).used, 0);
      const { app, auth } = await createApp(config, db),
        token = await auth.session(u.id),
        cookie = `nota_session=${encodeURIComponent(app.signCookie(token))}`;
      try {
        const detail = await app.inject({ url: `/api/recordings/${file.id}`, headers: { cookie } });
        assert.equal(detail.json().recording.retry_operation_id, batch.agent_operation_id);
        const retry = await app.inject({
          method: 'POST',
          url: `/api/operations/${batch.agent_operation_id}/retry`,
          headers: { cookie },
          payload: {},
        });
        assert.equal(retry.statusCode, 200, retry.body);
        assert.equal((await ops.usage(u.id)).reserved, 1);
        const replay = await app.inject({
          method: 'POST',
          url: `/api/operations/${batch.agent_operation_id}/retry`,
          headers: { cookie },
          payload: {},
        });
        assert.equal(replay.statusCode, 200);
        assert.equal((await ops.usage(u.id)).reserved, 1);
        runtime.agent.run = async () => ({
          text: '整理结果已汇总。',
          usage: 0,
          sessionPath: null,
          waiting: undefined,
        });
        await runtime.processUser(u.id);
        assert.equal((await ops.usage(u.id)).used, 1);
        assert.equal((await ops.usage(u.id)).reserved, 0);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    'Editing a prepared source before dispatch reopens the same window item with no extra credit',
    async () => {
      const u = await f.user(),
        file = await upload(u.id);
      await pipeline.process(file.op.id);
      const { app, auth } = await createApp(config, db),
        token = await auth.session(u.id),
        cookie = `nota_session=${encodeURIComponent(app.signCookie(token))}`;
      try {
        const edited = await app.inject({
          method: 'PATCH',
          url: `/api/recordings/${file.id}`,
          headers: { cookie },
          payload: { transcript: file.text + '\n补充：文件版本更新。' },
        });
        assert.equal(edited.statusCode, 200, edited.body);
        assert.equal(
          (
            await db.query('SELECT state FROM recording_batch_items WHERE batch_id=$1', [
              file.batch,
            ])
          ).rows[0].state,
          'pending',
        );
        await dispatchWindows(db, 100);
        assert.equal(
          (await db.query('SELECT * FROM agent_inbox WHERE user_id=$1', [u.id])).rowCount,
          0,
        );
        await pipeline.process(file.op.id);
        const items = await windowResults(db, u.id, file.batch);
        assert.equal(items.length, 1);
        assert.equal(items[0].recording_version, 2);
        assert.equal((await ops.usage(u.id)).reserved, 1);
        assert.equal((await sourceDocument(db, u.id, 'recording', file.id, 1)).text, file.text);
      } finally {
        await app.close();
      }
    },
  );
  await check(
    'Only-summary material rejects automatic actions even when a model proposes an explicit candidate',
    async () => {
      const u = await f.user(),
        file = await upload(u.id);
      await db.query(
        "UPDATE operations SET input=jsonb_set(input,'{instruction}','\"仅摘要，不创建任何提醒\"') WHERE id=$1",
        [file.op.id],
      );
      await pipeline.process(file.op.id);
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE id=$1",
        [file.batch],
      );
      await dispatchWindows(db, 100);
      const batch = (await db.query('SELECT * FROM recording_batches WHERE id=$1', [file.batch]))
          .rows[0],
        runtime = new Runtime(db, config);
      runtime.agent.run = async (ctx) => {
        const candidate = (
          await db.query(
            'SELECT a.* FROM candidate_actions a JOIN recording_batch_items i ON i.artifact_id=a.artifact_id WHERE i.batch_id=$1',
            [file.batch],
          )
        ).rows[0];
        const tool = buildTools(ctx).find((t) => t.name === 'create_reminder')!;
        const denied = await tool.execute('out-of-scope', {
          title: '核对附件',
          remind_at: new Date(Date.now() + 864e5).toISOString(),
          candidate_id: candidate.id,
        });
        assert((denied.details as any).error);
        assert.equal(
          (await db.query('SELECT * FROM reminders WHERE user_id=$1', [u.id])).rowCount,
          0,
        );
        return { text: '已按要求只整理摘要。', usage: 0, sessionPath: null, waiting: undefined };
      };
      await runtime.processUser(u.id);
    },
  );
  await check('Explicit embedding retry resumes without running chat memory analysis', async () => {
    const u = await f.user(),
      op = await ops.submit(u.id, randomUUID(), '青禾项目报价8.6万元。明天上午9点提醒我核对附件。'),
      message = (
        await db.query("SELECT id FROM messages WHERE operation_id=$1 AND role='user'", [op.id])
      ).rows[0];
    const { enqueueIndex } = await import('../src/server/sources.js');
    await enqueueIndex(db, u.id, 'message', message.id, 1, 'embedding');
    const job = (await db.query('SELECT * FROM source_index_jobs WHERE source_id=$1', [message.id]))
        .rows[0],
      original = pipeline.analyzer.analyze,
      index = pipeline.embeddings.index;
    let calls = 0;
    pipeline.analyzer.analyze = async (...args) => {
      calls++;
      return original(...args);
    };
    pipeline.embeddings.index = async () => {
      throw new Error('controlled embedding outage');
    };
    await pipeline.processIndex(job.id);
    assert.equal(
      (await db.query('SELECT stage FROM source_index_jobs WHERE id=$1', [job.id])).rows[0].stage,
      'embedding',
    );
    pipeline.embeddings.index = async () => {};
    await pipeline.processIndex(job.id);
    assert.equal(calls, 0);
    assert.equal(
      (await db.query('SELECT status FROM source_index_jobs WHERE id=$1', [job.id])).rows[0].status,
      'succeeded',
    );
    pipeline.analyzer.analyze = original;
    pipeline.embeddings.index = index;
  });
  await check(
    'Event-relative reminder offsets are calculated from the event and conflicting model clock times cannot write',
    async () => {
      const u = await f.user(),
        file = await upload(
          u.id,
          '青禾项目报价8.6万元。后天下午三点到四点参加评审。请提前一天提醒我参加评审。',
        ),
        original = pipeline.analyzer.analyze;
      pipeline.analyzer.analyze = async () => ({
        summary: '有一场评审，需要提前一天提醒。',
        facts: [],
        actions: [
          {
            kind: 'event',
            title: '参加评审',
            actor: 'self',
            explicit: true,
            evidence: '后天下午三点到四点参加评审',
          },
          {
            kind: 'reminder',
            title: '评审提醒',
            actor: 'self',
            explicit: true,
            evidence: '请提前一天提醒我参加评审',
          },
        ],
        uncertainties: [],
      });
      await pipeline.process(file.op.id);
      pipeline.analyzer.analyze = original;
      await db.query(
        "UPDATE recording_batches SET drained_at=now()-interval '1 second' WHERE id=$1",
        [file.batch],
      );
      await dispatchWindows(db, 100);
      const runtime = new Runtime(db, config);
      runtime.agent.run = async (ctx, prompt) => {
        const actions = JSON.parse(prompt).recording_batch.items[0].actions,
          tools = buildTools(ctx),
          start = new Date(Date.now() + 4 * 864e5).toISOString();
        const event = (
          await tools
            .find((t) => t.name === 'create_event')!
            .execute('create-event', {
              title: '参加评审',
              starts_at: start,
              ends_at: new Date(Date.parse(start) + 3600000).toISOString(),
              candidate_id: actions.find((a: any) => a.payload.kind === 'event').candidate_id,
            })
        ).details as any;
        const candidate = actions.find((a: any) => a.payload.kind === 'reminder');
        const wrong = await tools
          .find((t) => t.name === 'create_reminder')!
          .execute('wrong-reminder', {
            title: '评审提醒',
            event_id: event.id,
            remind_at: new Date(Date.parse(start) - 864e5 + 5 * 3600000).toISOString(),
            candidate_id: candidate.candidate_id,
          });
        assert((wrong.details as any).error);
        assert.equal(
          (await db.query('SELECT * FROM reminders WHERE user_id=$1', [u.id])).rowCount,
          0,
        );
        const correct = await tools
          .find((t) => t.name === 'create_reminder')!
          .execute('correct-reminder', {
            title: '评审提醒',
            event_id: event.id,
            before_minutes: 1440,
            candidate_id: candidate.candidate_id,
          });
        assert.equal(
          new Date((correct.details as any).remind_at).toISOString(),
          new Date(Date.parse(start) - 864e5).toISOString(),
        );
        return {
          text: '评审日程和提前一天的提醒已创建。',
          usage: 0,
          sessionPath: null,
          waiting: undefined,
        };
      };
      await runtime.processUser(u.id);
    },
  );
} finally {
  pipeline.stop();
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/recording-integration.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  await f.close();
}
console.log(`${results.length} recording pipeline scenarios passed`);
