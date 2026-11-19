import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { Operations } from '../src/server/quota.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';
import { sealInputs } from '../src/server/steering.js';
import { nativeSteeringFixture } from './steering-fixture.js';
import { createEvent, createReminder } from '../src/server/domain.js';

const report: { name: string; ok: boolean }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  report.push({ name, ok: true });
  console.log('PASS ' + name);
}
const fixture = await testDatabase(),
  { db, config, user } = fixture,
  ops = new Operations(db, config);
async function running(userId: string) {
  const op = await ops.submit(userId, randomUUID(), '后天上午3点叫我');
  const token = randomUUID();
  await db.query(
    "UPDATE operations SET status='running',lease_token=$2,lease_until=now()+interval '2 minutes',attempts=1 WHERE id=$1",
    [op.id, token],
  );
  const ctx: ToolContext = {
    db,
    userId,
    operationId: op.id,
    leaseToken: token,
    attempt: 1,
    cycle: 0,
    requestVersion: 0,
    signal: new AbortController().signal,
  };
  return { op, ctx };
}
try {
  await check(
    '50 explicit new queued tasks still accept exactly 10 independent Free requests',
    async () => {
      const u = await user();
      const attempts = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          ops.submit(u.id, `explicit-queue-${i}`, '独立交办' + i, { mode: 'queue' }),
        ),
      );
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 10);
      for (const result of attempts)
        if (result.status === 'rejected') assert.equal(result.reason.code, 'quota_exhausted');
      assert.equal((await ops.usage(u.id)).reserved, 10);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM chat_inputs WHERE user_id=$1', [u.id]))
          .rows[0].n,
        10,
      );
    },
  );
  await check(
    'Default submissions steer one operation; retries, explicit queues and owners stay correct',
    async () => {
      const a = await user(),
        b = await user();
      const first = await ops.submit(a.id, randomUUID(), '后天上午3点叫我');
      const key = randomUUID();
      const next = await ops.submit(a.id, key, '不，6点吧');
      assert.equal(next.id, first.id);
      assert.equal(next.steered, true);
      const retries = await Promise.all(
        Array.from({ length: 20 }, () => ops.submit(a.id, key, '不，6点吧')),
      );
      assert.ok(retries.every((r) => r.id === first.id && r.replayed));
      assert.equal((await ops.usage(a.id)).reserved, 1);
      assert.equal(
        (await db.query('SELECT input_version FROM operations WHERE id=$1', [first.id])).rows[0]
          .input_version,
        1,
      );
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM messages WHERE user_id=$1', [a.id])).rows[0]
          .n,
        2,
      );
      await assert.rejects(
        () => ops.submit(a.id, key, '改成7点'),
        (e: any) => e.code === 'idempotency_conflict',
      );
      await assert.rejects(
        () => ops.submit(b.id, randomUUID(), '不，6点吧', { targetId: first.id }),
        (e: any) => e.status === 404,
      );
      const queue = await ops.submit(a.id, randomUUID(), '另一个任务', { mode: 'queue' });
      assert.notEqual(queue.id, first.id);
      assert.equal((await ops.usage(a.id)).reserved, 2);
    },
  );
  await check('A stale pending question cannot hijack a newer completed conversation', async () => {
    const u = await user();
    const old = await ops.submit(u.id, randomUUID(), '3点叫我');
    await db.query("UPDATE operations SET status='waiting' WHERE id=$1", [old.id]);
    const newer = await ops.submit(u.id, randomUUID(), '改成6点', { mode: 'queue' });
    await db.query("UPDATE operations SET status='succeeded' WHERE id=$1", [newer.id]);
    const current = await ops.submit(u.id, randomUUID(), '查看现在的安排');
    assert.notEqual(current.id, old.id);
    assert.equal(current.steered, false);
    await db.query("UPDATE operations SET status='succeeded' WHERE id=$1", [current.id]);
    await ops.submit(u.id, randomUUID(), '继续先前的交办', { targetId: old.id });
    await db.query("UPDATE operations SET status='waiting',updated_at=now() WHERE id=$1", [old.id]);
    const resumed = await ops.submit(u.id, randomUUID(), '上午6点');
    assert.equal(resumed.id, old.id);
    assert.equal(resumed.steered, true);
  });
  await check(
    'Unexecuted old parameters are superseded; completed reminders update in place across repeated corrections',
    async () => {
      const u = await user(),
        { op, ctx } = await running(u.id),
        tools = buildTools(ctx);
      const at = (h: number) => new Date(Date.now() + 2 * 864e5 + h * 36e5).toISOString();
      await ops.submit(u.id, randomUUID(), '不，6点吧', { targetId: op.id });
      const skipped = await tools
        .find((t) => t.name === 'create_reminder')!
        .execute('old-3', { title: '叫我', remind_at: at(3) });
      assert.equal((skipped.details as any).superseded, true);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM reminders WHERE user_id=$1', [u.id]))
          .rows[0].n,
        0,
      );
      ctx.requestVersion = 1;
      const created = await tools
        .find((t) => t.name === 'create_reminder')!
        .execute('new-6', { title: '叫我', remind_at: at(6) });
      const reminder = created.details as any;
      assert.ok(reminder.id);
      const six = at(6),
        seven = at(7);
      for (const [index, time] of [seven, six, seven, six].entries()) {
        await ops.submit(u.id, randomUUID(), '调整时间', { targetId: op.id });
        ctx.requestVersion = index + 2;
        await tools
          .find((t) => t.name === 'update_reminder')!
          .execute('update-' + index, { reminder_id: reminder.id, remind_at: time });
        assert.equal(
          new Date(
            (await db.query('SELECT remind_at FROM reminders WHERE id=$1', [reminder.id])).rows[0]
              .remind_at,
          ).toISOString(),
          time,
        );
      }
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM reminders WHERE user_id=$1', [u.id]))
          .rows[0].n,
        1,
      );
      assert.equal((await ops.usage(u.id)).reserved, 1);
    },
  );
  await check(
    'Finishing and steering admission are atomic, with a safe completed-turn fallback',
    async () => {
      const u = await user(),
        { op, ctx } = await running(u.id);
      await ops.submit(u.id, randomUUID(), '改成6点', { targetId: op.id });
      assert.equal(await sealInputs(db, ctx, 0), false);
      assert.equal(await sealInputs(db, ctx, 1), true);
      const key = randomUUID();
      await assert.rejects(
        () => ops.submit(u.id, key, '再改7点', { targetId: op.id }),
        (e: any) => e.code === 'turn_finished',
      );
      const next = await ops.submit(u.id, key, '再改7点', { mode: 'queue' });
      assert.notEqual(next.id, op.id);
    },
  );
  await check(
    'Native Pi SDK exposes event fields and edits location without replacement or collateral changes',
    async () => {
      const native = await nativeSteeringFixture('event_edit');
      try {
        const u = await native.user();
        const event = await native.db.tx((c) =>
          createEvent(c, u.id, {
            title: native.title,
            starts_at: native.at(10),
            ends_at: native.at(11),
            timezone: 'Asia/Tokyo',
            location: '原地点',
            notes: '原备注',
          }),
        );
        const reminder = await native.db.tx((c) =>
          createReminder(c, u.id, { title: '提前出发', event_id: event.id, before_minutes: 30 }),
        );
        const op = await native.ops.submit(
          u.id,
          randomUUID(),
          `把“${native.title}”的地点改为科苑地铁站附近，只改地点，其他保留。`,
        );
        await native.runtime.processUser(u.id);
        const result = (
          await native.db.query('SELECT status,last_error FROM operations WHERE id=$1', [op.id])
        ).rows[0];
        assert.equal(result.status, 'succeeded', result.last_error);
        const rows = (
          await native.db.query('SELECT * FROM calendar_events WHERE user_id=$1', [u.id])
        ).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, event.id);
        assert.equal(rows[0].location, '科苑地铁站附近');
        assert.equal(rows[0].notes, '原备注');
        assert.equal(rows[0].timezone, 'Asia/Tokyo');
        assert.equal(rows[0].status, 'confirmed');
        const retained = (await native.db.query('SELECT * FROM reminders WHERE user_id=$1', [u.id]))
          .rows;
        assert.equal(retained.length, 1);
        assert.equal(retained[0].id, reminder.id);
        assert.equal(+new Date(retained[0].remind_at), +new Date(reminder.remind_at));
        assert.deepEqual(
          (
            await native.db.query(
              'SELECT name FROM tool_calls WHERE operation_id=$1 ORDER BY started_at',
              [op.id],
            )
          ).rows.map((row) => row.name),
          ['get_agenda', 'get_event', 'update_event', 'get_event'],
        );
        assert.deepEqual(native.providerErrors, []);
      } finally {
        await native.close();
      }
    },
  );
  for (const scenario of ['correction', 'clarification'] as const)
    await check(
      `Native Pi SDK ${scenario}: queued input survives tool boundaries and preserves actual history`,
      async () => {
        const native = await nativeSteeringFixture(scenario);
        try {
          const u = await native.user(),
            first = await native.ops.submit(u.id, randomUUID(), '设置后天上午3点叫我起床');
          const job = native.runtime.processUser(u.id);
          await Promise.race([
            native.first.wait,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Provider did not start')), 15000),
            ),
          ]);
          const steer = await native.ops.submit(u.id, randomUUID(), '不，上午6点吧', {
            targetId: first.id,
          });
          assert.equal(steer.id, first.id);
          native.releaseFirst.open();
          let originalId: string | undefined;
          if (scenario === 'correction') {
            await Promise.race([
              native.afterCreate.wait,
              job.then(() => {
                throw new Error('Run ended before the created reminder boundary');
              }),
            ]);
            const rows = (
              await native.db.query('SELECT id,remind_at FROM reminders WHERE user_id=$1', [u.id])
            ).rows;
            assert.equal(rows.length, 1);
            originalId = rows[0].id;
            assert.equal(
              new Date(rows[0].remind_at).toISOString(),
              new Date(native.at(6)).toISOString(),
            );
            await native.ops.submit(u.id, randomUUID(), '改成上午7点吧', { targetId: first.id });
            native.releaseAfterCreate.open();
          }
          await job;
          const final = (await native.db.query('SELECT * FROM operations WHERE id=$1', [first.id]))
            .rows[0];
          assert.equal(final.status, 'succeeded', final.last_error);
          const reminders = (
            await native.db.query('SELECT id,remind_at FROM reminders WHERE user_id=$1', [u.id])
          ).rows;
          assert.equal(reminders.length, 1);
          assert.equal(
            new Date(reminders[0].remind_at).toISOString(),
            new Date(native.at(scenario === 'correction' ? 7 : 6)).toISOString(),
          );
          if (originalId) assert.equal(reminders[0].id, originalId);
          assert.equal((await native.ops.usage(u.id)).used, 1);
          assert.equal((await native.ops.usage(u.id)).reserved, 0);
          assert.equal(
            (
              await native.db.query(
                "SELECT count(*)::int AS n FROM chat_inputs WHERE operation_id=$1 AND status='pending'",
                [first.id],
              )
            ).rows[0].n,
            0,
          );
          const history = (await native.app.inject({ method: 'GET', url: '/api/health' }))
            .statusCode;
          assert.equal(history, 200);
          assert.ok(JSON.stringify(native.requests).includes('不，上午6点吧'));
          if (scenario === 'correction')
            assert.equal(
              (
                await native.db.query(
                  "SELECT count(*)::int AS n FROM tool_calls WHERE operation_id=$1 AND status='superseded'",
                  [first.id],
                )
              ).rows[0].n,
              1,
            );
          assert.deepEqual(native.providerErrors, []);
        } finally {
          await native.close();
        }
      },
    );
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/steering-integration.json',
    JSON.stringify({ at: new Date().toISOString(), results: report }, null, 2),
  );
  console.log(report.length + ' steering integration scenarios passed');
} finally {
  await fixture.close();
}
