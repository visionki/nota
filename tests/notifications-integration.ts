import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { backgroundFixture } from './background-fixture.js';
import { notify, notifications } from '../src/server/notifications.js';
import { activateSchedules, deliverReminders } from '../src/server/scheduler.js';
import { buildTools } from '../src/server/tools.js';
import { createArrangement } from '../src/server/domain.js';

const f = await backgroundFixture();
const { db, runtime } = f;
const results: { name: string; ok: boolean }[] = [];
const check = async (name: string, fn: () => Promise<void>) => {
  await fn();
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
};
const operation = async (id: string) =>
  (await db.query('SELECT * FROM operations WHERE id=$1', [id])).rows[0];
const report = async (id: string) =>
  (
    await db.query(
      "SELECT * FROM operations WHERE input->>'background_operation_id'=$1 ORDER BY created_at DESC LIMIT 1",
      [id],
    )
  ).rows[0];
const request = async (userId: string, path: string, body: object) =>
  f.app.inject({
    method: 'POST',
    url: `/api${path}`,
    payload: body,
    headers: {
      cookie: `nota_session=${encodeURIComponent(f.app.signCookie(await f.auth.session(userId)))}`,
    },
  });
const task = (userId: string, policy = 'always') =>
  runtime.ops.create(userId, randomUUID(), 'trigger', {
    text: '查询本周公告',
    schedule_title: '本周公告',
    source: 'schedule',
    notification_policy: policy,
  });
const structuredTask = async (
  id: string,
  outcome: { summary: string; has_update: boolean; needs_input: boolean },
) => {
  const original = runtime.tasks.agent.run;
  runtime.tasks.agent.run = async (ctx) => {
    await buildTools(ctx)
      .find((tool) => tool.name === 'report_task_outcome')!
      .execute(randomUUID(), outcome);
    return { text: outcome.summary, usage: 0, sessionPath: 'controlled-task', waiting: undefined };
  };
  try {
    await runtime.tasks.process(id);
  } finally {
    runtime.tasks.agent.run = original;
  }
};
try {
  await check(
    'Chat answers, clarification questions and immediate arrangement receipts never become notifications',
    async () => {
      const u = await f.user();
      await runtime.ops.submit(u.id, randomUUID(), '你好');
      await runtime.processUser(u.id);
      const original = runtime.agent.run;
      runtime.agent.run = async () => ({
        text: '请确认是哪位陈总',
        waiting: '请确认是哪位陈总',
        usage: 0,
        sessionPath: 'controlled-chat',
      });
      try {
        const op = await runtime.ops.submit(u.id, randomUUID(), '约陈总见面');
        await runtime.processUser(u.id);
        assert.equal((await operation(op.id)).status, 'waiting');
      } finally {
        runtime.agent.run = original;
      }
      await db.tx((c) =>
        createArrangement(c, u.id, {
          title: '看牙',
          starts_at: new Date(Date.now() + 86400000).toISOString(),
        }),
      );
      assert.equal((await notifications(db, u.id)).length, 0);
      assert.equal(
        (await db.query("SELECT * FROM messages WHERE user_id=$1 AND role='assistant'", [u.id]))
          .rowCount,
        2,
      );
    },
  );

  await check(
    'Reminder delivery links the exact message once; reading it clears its notification without AI usage',
    async () => {
      const u = await f.user(),
        id = randomUUID();
      await db.query(
        "INSERT INTO reminders(id,user_id,title,remind_at,dedupe_key) VALUES($1,$2,'看牙提醒',now()-interval '1 second',$3)",
        [id, u.id, id],
      );
      await Promise.all(Array.from({ length: 5 }, () => deliverReminders(db)));
      const rows = await notifications(db, u.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'reminder');
      assert.equal(rows[0].object_type, 'reminder');
      assert.ok(rows[0].message_id);
      assert.equal(rows[0].read_at, null);
      assert.equal(
        (await request(u.id, '/chat/read', { message_id: rows[0].message_id })).statusCode,
        200,
      );
      assert.ok((await notifications(db, u.id))[0].read_at);
      assert.equal((await runtime.ops.usage(u.id)).used, 0);
    },
  );

  await check(
    'Background progress creates no notifications and final delivery creates one plain preview linked to its result',
    async () => {
      const u = await f.user(),
        op = await task(u.id);
      assert.equal((await notifications(db, u.id)).length, 0);
      await runtime.tasks.process(op.id);
      assert.equal((await notifications(db, u.id)).length, 0);
      await Promise.all([runtime.processUser(u.id), runtime.processUser(u.id)]);
      const rows = await notifications(db, u.id),
        delivery = await report(op.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'task_result');
      assert.equal(rows[0].title, '任务结果：本周公告');
      assert.ok(!rows[0].body.includes(']('));
      const message = (await db.query('SELECT * FROM messages WHERE id=$1', [rows[0].message_id]))
        .rows[0];
      assert.equal(message.operation_id, delivery.id);
    },
  );

  await check(
    'Reading one result cannot consume a later result, even when both belong to the same operation',
    async () => {
      const u = await f.user(),
        op = await task(u.id);
      const add = async (key: string) =>
        db.tx(async (c) => {
          const m = (
            await c.query(
              "INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key) VALUES($1,$2,$3,'assistant',$4,$4) RETURNING id",
              [randomUUID(), u.id, op.id, key],
            )
          ).rows[0];
          await notify(c, u.id, key, {
            kind: 'task_result',
            title: key,
            body: key,
            objectId: op.id,
            messageId: m.id,
          });
          return m.id;
        });
      const first = await add('first-result');
      await request(u.id, '/chat/read', { message_id: first });
      const second = await add('second-result');
      await request(u.id, '/chat/read', { message_id: first });
      const rows = await notifications(db, u.id);
      assert.ok(rows.find((n) => n.message_id === first).read_at);
      assert.equal(rows.find((n) => n.message_id === second).read_at, null);
      await runtime.ops.cancel(u.id, op.id);
    },
  );

  await check(
    'Only-change tasks keep unchanged results in execution history; reports and uncertain results still deliver',
    async () => {
      for (const policy of ['on_change', 'always']) {
        const u = await f.user(),
          op = await task(u.id, policy);
        await structuredTask(op.id, {
          summary: '已核实，没有新公告。',
          has_update: false,
          needs_input: false,
        });
        assert.equal((await operation(op.id)).status, 'succeeded');
        assert.match((await operation(op.id)).reply, /没有新公告/);
        const delivery = await report(op.id);
        if (policy === 'on_change') {
          assert.equal(delivery, undefined);
          assert.equal((await notifications(db, u.id)).length, 0);
        } else {
          assert.ok(delivery);
          await runtime.processUser(u.id);
          assert.equal((await notifications(db, u.id)).length, 1);
        }
      }
      const u = await f.user(),
        op = await task(u.id, 'on_change');
      await runtime.tasks.process(op.id); // No structured change signal: deliver conservatively.
      assert.ok(await report(op.id));
      await runtime.processUser(u.id);
      assert.equal((await notifications(db, u.id))[0].kind, 'task_result');
    },
  );

  await check(
    'A blocked task stays pending after read; a reply resumes the same task, resolves the prompt and uses one credit',
    async () => {
      const u = await f.user(),
        op = await task(u.id, 'on_change');
      await structuredTask(op.id, {
        summary: '请确认要查询哪家公司的公告。',
        has_update: false,
        needs_input: true,
      });
      await runtime.processUser(u.id);
      const delivery = await report(op.id),
        before = (await notifications(db, u.id))[0];
      assert.equal((await operation(delivery.id)).status, 'waiting');
      assert.equal(before.kind, 'attention');
      assert.equal(before.resolved_at, null);
      await request(u.id, '/notifications/read', { ids: [before.id] });
      await request(u.id, '/chat/read', { message_id: before.message_id });
      assert.equal((await notifications(db, u.id))[0].resolved_at, null);
      const followup = await runtime.ops.submit(u.id, randomUUID(), '星河科技的公告');
      assert.equal(followup.id, delivery.id);
      assert.ok((await notifications(db, u.id))[0].resolved_at);
      await runtime.processUser(u.id);
      assert.equal((await operation(delivery.id)).status, 'succeeded');
      assert.equal(
        (await notifications(db, u.id)).filter((n) => n.kind === 'task_result').length,
        1,
      );
      assert.equal((await runtime.ops.usage(u.id)).used, 1);
    },
  );

  await check(
    'Transient retries remain quiet; final failure is actionable, tenant isolated and resolved on explicit retry',
    async () => {
      const u = await f.user(),
        other = await f.user();
      const op = await runtime.ops.submit(u.id, randomUUID(), '帮我查一下公告');
      const original = runtime.agent.run;
      runtime.agent.run = async () => {
        throw new Error('临时网络错误');
      };
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          await db.query("UPDATE operations SET updated_at=now()-interval '1 minute' WHERE id=$1", [
            op.id,
          ]);
          await runtime.processUser(u.id);
          assert.equal((await notifications(db, u.id)).length, attempt === 2 ? 1 : 0);
        }
      } finally {
        runtime.agent.run = original;
      }
      const failed = (await notifications(db, u.id))[0];
      assert.equal(failed.kind, 'attention');
      assert.equal(failed.object_status, 'failed');
      await request(other.id, '/notifications/read', { ids: [failed.id] });
      assert.equal((await notifications(db, u.id))[0].read_at, null);
      assert.equal((await request(other.id, `/operations/${op.id}/retry`, {})).statusCode, 404);
      await request(u.id, '/chat/read', { message_id: failed.message_id });
      assert.equal((await request(u.id, `/operations/${op.id}/retry`, {})).statusCode, 200);
      assert.ok((await notifications(db, u.id))[0].resolved_at);
      runtime.agent.run = async () => {
        throw new Error('尚未配置受控重试服务');
      };
      try {
        await runtime.processUser(u.id);
      } finally {
        runtime.agent.run = original;
      }
      const failedAgain = (await notifications(db, u.id)).find((n) => n.id !== failed.id);
      assert.ok(failedAgain);
      assert.notEqual(failedAgain.message_id, failed.message_id);
      assert.equal(failedAgain.read_at, null);
      assert.equal((await request(u.id, `/operations/${op.id}/retry`, {})).statusCode, 200);
      await runtime.processUser(u.id);
      assert.equal((await operation(op.id)).status, 'succeeded');
      assert.equal((await notifications(db, u.id)).length, 2);
      assert.ok((await notifications(db, u.id)).every((n) => n.resolved_at));
    },
  );

  await check(
    'Retrying a blocked-task followup is free even after the account quota is exhausted',
    async () => {
      const u = await f.user(),
        op = await task(u.id);
      await structuredTask(op.id, {
        summary: '请确认查询哪家公司。',
        has_update: true,
        needs_input: true,
      });
      await runtime.processUser(u.id);
      const delivery = await report(op.id);
      await runtime.ops.submit(u.id, randomUUID(), '星河科技', { targetId: delivery.id });
      const original = runtime.agent.run;
      runtime.agent.run = async () => {
        throw new Error('尚未配置受控补充服务');
      };
      try {
        await runtime.processUser(u.id);
      } finally {
        runtime.agent.run = original;
      }
      assert.equal((await operation(delivery.id)).status, 'failed');
      await db.query('UPDATE quota_buckets SET used=$2 WHERE user_id=$1', [
        u.id,
        f.config.FREE_DAILY_LIMIT,
      ]);
      assert.equal((await request(u.id, `/operations/${delivery.id}/retry`, {})).statusCode, 200);
      await runtime.processUser(u.id);
      assert.equal((await operation(delivery.id)).status, 'succeeded');
      assert.equal((await runtime.ops.usage(u.id)).used, f.config.FREE_DAILY_LIMIT);
      assert.equal((await runtime.ops.usage(u.id)).reserved, 0);
    },
  );

  await check(
    'An old failure report delivered after recovery cannot recreate a stale pending notification',
    async () => {
      const u = await f.user(),
        op = await task(u.id);
      const original = runtime.tasks.agent.run;
      runtime.tasks.agent.run = async () => {
        throw new Error('尚未配置受控查询服务');
      };
      try {
        await runtime.tasks.process(op.id);
      } finally {
        runtime.tasks.agent.run = original;
      }
      assert.equal((await operation(op.id)).status, 'failed');
      assert.equal((await request(u.id, `/operations/${op.id}/retry`, {})).statusCode, 200);
      await runtime.tasks.process(op.id);
      await runtime.processUser(u.id); // The already-saved failure report is delivered first.
      assert.equal((await notifications(db, u.id)).length, 0);
      await runtime.processUser(u.id);
      const rows = await notifications(db, u.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'task_result');
    },
  );

  await check(
    'Repeated schedule activation failures form one incident and pausing the schedule resolves it',
    async () => {
      const u = await f.user(),
        id = randomUUID();
      await db.query(
        'INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,CURRENT_DATE,10)',
        [u.id],
      );
      // Account quota days use Shanghai, independently of the database server time zone.
      await db.query(
        "UPDATE quota_buckets SET quota_day=(now() AT TIME ZONE 'Asia/Shanghai')::date WHERE user_id=$1",
        [u.id],
      );
      await db.query(
        "INSERT INTO schedules(id,user_id,title,prompt,cron,next_run_at) VALUES($1,$2,'公告监控','查询公告','0 9 * * *',now()-interval '1 minute')",
        [id, u.id],
      );
      for (let n = 0; n < 3; n++) {
        await db.query("UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1", [
          id,
        ]);
        await activateSchedules(db, runtime.ops);
      }
      const rows = await notifications(db, u.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'attention');
      assert.equal(rows[0].object_type, 'schedule');
      const cookie = `nota_session=${encodeURIComponent(f.app.signCookie(await f.auth.session(u.id)))}`;
      const paused = await f.app.inject({
        method: 'PATCH',
        url: `/api/schedules/${id}`,
        payload: { active: false },
        headers: { cookie },
      });
      assert.equal(paused.statusCode, 200);
      assert.ok((await notifications(db, u.id))[0].resolved_at);
      // Re-enabling a single-run schedule reuses its original trigger instant, but is a new incident.
      await db.query(
        "UPDATE schedules SET active=true,cron=NULL,next_run_at=now()-interval '1 minute' WHERE id=$1",
        [id],
      );
      const instant = (await db.query('SELECT next_run_at FROM schedules WHERE id=$1', [id]))
        .rows[0].next_run_at;
      await activateSchedules(db, runtime.ops);
      const secondIncident = (await notifications(db, u.id)).find((n) => !n.resolved_at);
      assert.ok(secondIncident);
      await f.app.inject({
        method: 'PATCH',
        url: `/api/schedules/${id}`,
        payload: { active: false },
        headers: { cookie },
      });
      await db.query('UPDATE schedules SET active=true,next_run_at=$2 WHERE id=$1', [id, instant]);
      await activateSchedules(db, runtime.ops);
      const thirdIncident = (await notifications(db, u.id)).find((n) => !n.resolved_at);
      assert.ok(thirdIncident);
      assert.notEqual(thirdIncident.id, secondIncident.id);
    },
  );

  await check(
    'Upgrade archives old chat duplicates, retains real events and is idempotent',
    async () => {
      const u = await f.user();
      const chat = await runtime.ops.submit(u.id, randomUUID(), '普通回复');
      await runtime.processUser(u.id);
      const asyncOp = await task(u.id);
      for (const [op, kind, key] of [
        [chat, 'complete', 'legacy-chat'],
        [chat, 'question', 'legacy-question'],
        [asyncOp, 'complete', 'legacy-task'],
      ] as const)
        await db.query(
          'INSERT INTO notifications(id,user_id,title,body,kind,object_id,dedupe_key) VALUES($1,$2,$3,$3,$4,$5,$6)',
          [randomUUID(), u.id, 'Nota 已完成', kind, op.id, key],
        );
      await db.query('DELETE FROM schema_migrations WHERE version=3');
      await db.migrate();
      await db.migrate();
      const rows = await notifications(db, u.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, 'task_result');
      assert.equal(
        (
          await db.query(
            'SELECT * FROM notifications WHERE user_id=$1 AND archived_at IS NOT NULL',
            [u.id],
          )
        ).rowCount,
        2,
      );
      assert.equal((await request(u.id, '/notifications/read', {})).statusCode, 200);
      await runtime.ops.cancel(u.id, asyncOp.id);
    },
  );
  console.log(`${results.length} notification integration scenarios passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/notifications-integration.json', JSON.stringify(results, null, 2));
  await f.close();
}
