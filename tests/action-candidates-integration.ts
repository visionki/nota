import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase, wav } from './helpers.js';
import { recordingFixture } from './recording-fixture.js';
import { Operations } from '../src/server/quota.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';
import { sourceDocument, saveChunks, evidenceRefs } from '../src/server/sources.js';
import { joinWindow, finishWindowItem, dispatchWindows } from '../src/server/recording-windows.js';
import { materialPolicy } from '../src/server/recording-analysis.js';

const f = await testDatabase(),
  { db, config } = f,
  ops = new Operations(db, config);
const results: { name: string; ok: boolean }[] = [];
async function check(name: string, run: () => Promise<void>) {
  await run();
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
}
type Proposal = { kind: 'todo' | 'event' | 'reminder'; actor?: string; explicit?: boolean };
async function batch(
  options: { actions?: Proposal[]; instruction?: string; text?: string; userId?: string } = {},
) {
  const userId = options.userId ?? (await f.user()).id;
  const text = options.text ?? '下周二我要去看牙医拔智齿';
  const actions = options.actions ?? [{ kind: 'event' }];
  const value = await db.tx(async (c) => {
    const recordingId = randomUUID();
    const file = await ops.create(
      userId,
      randomUUID(),
      'recording',
      { recording_id: recordingId, instruction: options.instruction ?? '整理我的便签' },
      c,
    );
    await c.query(
      "INSERT INTO recordings(id,user_id,operation_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,recorded_at,recorded_timezone) VALUES($1,$2,$3,'候选类型验收',$4,'fixture.wav','audio/wav',44,1,$5,1,now(),'Asia/Shanghai')",
      [recordingId, userId, file.id, randomUUID(), text],
    );
    const source = await sourceDocument(c, userId, 'recording', recordingId, 1);
    const chunks = await saveChunks(c, userId, source),
      refs = evidenceRefs(source, chunks, text);
    const policy = materialPolicy(options.instruction ?? '整理我的便签');
    const artifactId = randomUUID();
    await c.query(
      'INSERT INTO recording_artifacts(id,user_id,recording_id,recording_version,summary,payload) VALUES($1,$2,$3,1,$4,$5)',
      [artifactId, userId, recordingId, text, JSON.stringify({ policy, actions })],
    );
    const ids: string[] = [];
    for (const [n, proposal] of actions.entries()) {
      const id = randomUUID();
      ids.push(id);
      const payload = {
        ...proposal,
        title: text,
        evidence: text,
        actor: proposal.actor ?? 'self',
        explicit: proposal.explicit ?? true,
        execution_allowed: policy.kinds[proposal.kind],
        uncertainty: '未说明是否已经预约',
      };
      await c.query(
        'INSERT INTO candidate_actions(id,user_id,artifact_id,candidate_key,payload,source_refs) VALUES($1,$2,$3,$4,$5,$6)',
        [id, userId, artifactId, String(n), JSON.stringify(payload), JSON.stringify(refs)],
      );
    }
    const batchId = await joinWindow(c, userId, file.id, recordingId);
    await finishWindowItem(c, userId, file.id, 'ready', artifactId);
    return { recordingId, refs, ids, batchId };
  });
  await dispatchWindows(db, 0);
  const operationId = (
    await db.query('SELECT agent_operation_id FROM recording_batches WHERE id=$1', [value.batchId])
  ).rows[0].agent_operation_id;
  const token = randomUUID();
  await db.query(
    "UPDATE operations SET status='running',lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",
    [operationId, token],
  );
  const ctx: ToolContext = {
    db,
    config,
    userId,
    operationId,
    leaseToken: token,
    attempt: 1,
    batchId: value.batchId,
    requestVersion: 0,
    signal: new AbortController().signal,
  };
  const tools = buildTools(ctx);
  const call = async (name: string, args: Record<string, any>) =>
    (await tools.find((tool) => tool.name === name)!.execute(randomUUID(), args)).details as any;
  return { ...value, userId, ctx, call };
}
const todo = { title: '去看牙医拔智齿', planned_date: '2026-11-17', timezone: 'Asia/Shanghai' };
const event = {
  title: '已经预约的看牙',
  starts_at: '2026-11-17T09:00:00+08:00',
  timezone: 'Asia/Shanghai',
};
async function counts(userId: string) {
  return (
    await db.query(
      'SELECT (SELECT count(*)::int FROM todos WHERE user_id=$1) AS todos,(SELECT count(*)::int FROM calendar_events WHERE user_id=$1) AS events,(SELECT count(*)::int FROM reminders WHERE user_id=$1) AS reminders',
      [userId],
    )
  ).rows[0];
}
try {
  await check(
    'The reported event-to-todo mismatch succeeds with its candidate ID and records one actual result',
    async () => {
      const b = await batch();
      const created = await b.call('create_todo', {
        ...todo,
        candidate_id: b.ids[0],
        source_refs: b.refs,
      });
      assert.ok(created.id);
      assert.equal(created.action_kind, 'todo');
      assert.equal(created.planned_date, '2026-11-17');
      const candidate = (await db.query('SELECT * FROM candidate_actions WHERE id=$1', [b.ids[0]]))
        .rows[0];
      assert.equal(candidate.payload.kind, 'event');
      assert.equal(candidate.result_type, 'todo');
      assert.equal(candidate.result_id, created.id);
      const replay = await b.call('create_todo', {
        ...todo,
        title: '同一事项的另一种说法',
        source_refs: b.refs,
      });
      assert.equal(replay.id, created.id);
      assert.equal(replay.candidate_id, b.ids[0]);
      const duplicate = await b.call('create_event', { ...event, candidate_id: b.ids[0] });
      assert.equal(duplicate.code, 'candidate_already_executed');
      assert.deepEqual(await counts(b.userId), { todos: 1, events: 0, reminders: 0 });
    },
  );
  await check(
    'A booked appointment can correct a provisional todo classification without creating both subjects',
    async () => {
      const b = await batch({ actions: [{ kind: 'todo' }], text: '我已经约好下周二上午九点看牙' });
      const created = await b.call('create_event', { ...event, candidate_id: b.ids[0] });
      assert.ok(created.id);
      assert.equal(created.ends_at, null);
      assert.equal(
        (await db.query('SELECT result_type FROM candidate_actions WHERE id=$1', [b.ids[0]]))
          .rows[0].result_type,
        'event',
      );
      assert.deepEqual(await counts(b.userId), { todos: 0, events: 1, reminders: 0 });
    },
  );
  await check(
    'Verified source-only calls bind the same candidate, retain its result, and replay safely',
    async () => {
      const b = await batch();
      const first = await b.call('create_todo', { ...todo, source_refs: b.refs });
      const again = await b.call('create_todo', { ...todo, source_refs: b.refs });
      assert.equal(first.id, again.id);
      assert.equal(first.candidate_id, b.ids[0]);
      assert.equal(
        (await db.query('SELECT result_id FROM candidate_actions WHERE id=$1', [b.ids[0]])).rows[0]
          .result_id,
        first.id,
      );
      assert.equal((await counts(b.userId)).todos, 1);
    },
  );
  await check(
    'Dropping candidate IDs cannot bypass actor or explicit-intent restrictions',
    async () => {
      for (const proposal of [
        { kind: 'event', actor: 'other' },
        { kind: 'event', actor: 'uncertain' },
        { kind: 'event', explicit: false },
      ] as Proposal[]) {
        const b = await batch({ actions: [proposal] });
        const code =
          proposal.explicit === false ? 'candidate_not_explicit' : 'candidate_actor_unconfirmed';
        for (const source of [{ candidate_id: b.ids[0] }, { source_refs: b.refs }]) {
          const denied = await b.call('create_todo', { ...todo, ...source });
          assert.equal(denied.code, code);
          assert.equal(denied.completed, false);
        }
        assert.deepEqual(await counts(b.userId), { todos: 0, events: 0, reminders: 0 });
      }
    },
  );
  await check(
    'Only-summary and target-kind restrictions remain effective during reclassification and source-only retries',
    async () => {
      const summary = await batch({ instruction: '仅摘要，不创建任何行动' });
      for (const source of [{ candidate_id: summary.ids[0] }, { source_refs: summary.refs }])
        assert.equal(
          (await summary.call('create_todo', { ...todo, ...source })).code,
          'candidate_scope_denied',
        );
      const target = await batch({ instruction: '不要创建待办' });
      assert.equal(
        (await target.call('create_todo', { ...todo, candidate_id: target.ids[0] })).code,
        'candidate_scope_denied',
      );
      assert.deepEqual(await counts(target.userId), { todos: 0, events: 0, reminders: 0 });
    },
  );
  await check(
    'Inline alerts still respect the recording policy and roll back the subject on rejection',
    async () => {
      const b = await batch({ instruction: '不要创建提醒' });
      const denied = await b.call('create_todo', {
        ...todo,
        candidate_id: b.ids[0],
        reminders: [{ remind_at: new Date(Date.now() + 864e5).toISOString() }],
      });
      assert.equal(denied.code, 'candidate_scope_denied');
      assert.deepEqual(await counts(b.userId), { todos: 0, events: 0, reminders: 0 });
    },
  );
  await check(
    'Reminder candidates cannot turn into subjects and ambiguity asks for an explicit candidate',
    async () => {
      const reminder = await batch({ actions: [{ kind: 'reminder' }] });
      for (const source of [{ candidate_id: reminder.ids[0] }, { source_refs: reminder.refs }])
        assert.equal(
          (await reminder.call('create_todo', { ...todo, ...source })).code,
          'candidate_kind_mismatch',
        );
      const ambiguous = await batch({ actions: [{ kind: 'event' }, { kind: 'event' }] });
      assert.equal(
        (await ambiguous.call('create_todo', { ...todo, source_refs: ambiguous.refs })).code,
        'candidate_ambiguous',
      );
      const created = await ambiguous.call('create_todo', {
        ...todo,
        candidate_id: ambiguous.ids[0],
      });
      assert.ok(created.id);
    },
  );
  await check(
    'Ownership, current batch and current recording version are enforced for IDs and source refs',
    async () => {
      const first = await batch(),
        sameUser = await batch({ userId: first.userId }),
        other = await batch();
      assert.equal(
        (await other.call('create_todo', { ...todo, candidate_id: first.ids[0] })).code,
        'candidate_not_found',
      );
      assert.equal(
        (await sameUser.call('create_todo', { ...todo, candidate_id: first.ids[0] })).code,
        'candidate_wrong_batch',
      );
      assert.equal(
        (await sameUser.call('create_todo', { ...todo, source_refs: first.refs })).code,
        'candidate_wrong_batch',
      );
      await db.query('UPDATE recordings SET version=2 WHERE id=$1', [first.recordingId]);
      assert.equal(
        (await first.call('create_todo', { ...todo, candidate_id: first.ids[0] })).code,
        'source_changed',
      );
      assert.equal(
        (await first.call('create_todo', { ...todo, source_refs: first.refs })).code,
        'source_changed',
      );
      assert.equal((await counts(first.userId)).todos, 0);
    },
  );
  await check(
    'New actions absent from analysis still accept verified current-batch source references',
    async () => {
      const b = await batch({ actions: [] });
      const created = await b.call('create_todo', { ...todo, source_refs: b.refs });
      assert.ok(created.id);
      assert.equal(created.recording_id, b.recordingId);
      assert.equal((await counts(b.userId)).todos, 1);
    },
  );
  await check(
    'Native Pi SDK executes an event candidate as a todo on its first tool call without dropping the candidate ID',
    async () => {
      const native = await recordingFixture({ candidateKind: 'event' });
      try {
        const registered = await fetch(`${native.base}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '候选类型 SDK 验收',
            email: `candidate-${randomUUID()}@nota.test`,
            password: randomUUID(),
          }),
        });
        assert.equal(registered.status, 200);
        const userId = (await registered.json()).user.id,
          cookie = registered.headers.getSetCookie()[0].split(';')[0];
        const form = new FormData();
        form.set('idempotency_key', randomUUID());
        form.set('recorded_at', new Date().toISOString());
        form.set('file', new Blob([new Uint8Array(wav())], { type: 'audio/wav' }), 'candidate.wav');
        const uploaded = await fetch(`${native.base}/api/recordings`, {
          method: 'POST',
          headers: { cookie },
          body: form,
        });
        assert.equal(uploaded.status, 200);
        await native.started.wait;
        await native.flush();
        const deadline = Date.now() + 15000;
        let candidate: any;
        do {
          candidate = (
            await native.db.query(
              'SELECT ca.* FROM candidate_actions ca JOIN recording_artifacts a ON a.id=ca.artifact_id WHERE ca.user_id=$1 ORDER BY ca.created_at DESC LIMIT 1',
              [userId],
            )
          ).rows[0];
          const reply = (
            await native.db.query("SELECT id FROM messages WHERE user_id=$1 AND role='assistant'", [
              userId,
            ])
          ).rowCount;
          if (candidate?.result_id && reply) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(candidate.payload.kind, 'event');
        assert.equal(candidate.result_type, 'todo');
        assert.ok(candidate.result_id);
        const calls = (
          await native.db.query(
            "SELECT * FROM tool_calls WHERE user_id=$1 AND name='create_todo' ORDER BY started_at",
            [userId],
          )
        ).rows;
        assert.equal(calls.length, 1);
        assert.equal(calls[0].status, 'succeeded');
        assert.equal(calls[0].input.candidate_id, candidate.id);
        assert.deepEqual(native.errors, []);
      } finally {
        await native.close();
      }
    },
  );
  console.log(`${results.length} action candidate integration scenarios passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/action-candidates-integration.json',
    JSON.stringify(results, null, 2),
  );
  await f.close();
}
