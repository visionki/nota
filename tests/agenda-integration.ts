import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { createApp } from '../src/server/app.js';
import {
  agenda,
  createArrangement,
  createEvent,
  createTodo,
  createReminder,
  getTodo,
  updateTodo,
  updateEvent,
  updateReminder,
  ics,
} from '../src/server/domain.js';
import { deliverReminders } from '../src/server/scheduler.js';
import { Operations } from '../src/server/quota.js';
import { buildTools, type ToolContext } from '../src/server/tools.js';
import { calendarItems, segmentsForDay } from '../src/web/calendar.js';

const fixture = await testDatabase();
const { db } = fixture;
const results: { name: string; ms: number }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  await fn();
  results.push({ name, ms: Date.now() - start });
  console.log(`PASS ${name}`);
}
const at = (day: string, time = '09:00') => `${day}T${time}:00+08:00`;
const sqlTime = (value: any) => new Date(value).toISOString();
const range = { from: at('2031-03-01', '00:00'), to: at('2031-04-01', '00:00') };
try {
  await check(
    'Date-only tasks enter the calendar directly; plans, deadlines and alerts remain distinct',
    async () => {
      const user = await fixture.user();
      const task = await db.tx((c) =>
        createTodo(c, user.id, { title: '两周后拔智齿', planned_date: '2031-03-14' }),
      );
      assert.equal(task.planned_date, '2031-03-14');
      assert.equal(task.planned_at, null);
      assert.equal(task.due_at, null);
      assert.equal(task.due_date, null);
      assert.equal(task.reminders.length, 0);
      await db.tx((c) => createTodo(c, user.id, { title: '截止材料', due_date: '2031-03-15' }));
      const result = await agenda(db, user.id, range.from, range.to);
      assert.equal(result.todos.length, 2);
      const items = calendarItems(result.events, result.reminders, result.todos);
      assert.equal(
        segmentsForDay(items, '2031-03-14', 'Asia/Shanghai')[0].item.id,
        `todo:${task.id}`,
      );
      assert.equal(segmentsForDay(items, '2031-03-14', 'Asia/Shanghai')[0].item.allDay, true);
      await assert.rejects(() =>
        db.tx((c) =>
          createTodo(c, user.id, {
            title: '冲突精度',
            planned_date: '2031-03-14',
            planned_at: at('2031-03-14'),
          }),
        ),
      );
      await assert.rejects(() =>
        db.tx((c) => createTodo(c, user.id, { title: '无效日期', due_date: '2031-02-30' })),
      );
    },
  );
  await check(
    'The creation type is explicit; events do not require a fabricated end time or notification',
    async () => {
      const user = await fixture.user();
      const point = await db.tx((c) =>
        createArrangement(c, user.id, { title: '9点已约看牙', starts_at: at('2031-03-14') }),
      );
      assert.equal(point.kind, 'event');
      assert.equal(point.event.ends_at, null);
      assert.equal(point.reminder, null);
      const wake = await db.tx((c) =>
        createArrangement(c, user.id, {
          kind: 'reminder',
          title: '叫醒我',
          remind_at: at('2031-03-14', '06:00'),
        }),
      );
      assert.equal(wake.event, null);
      assert.equal(wake.todo, null);
      assert.ok(wake.reminder.id);
      const day = await db.tx((c) =>
        createEvent(c, user.id, { title: '全天出差', all_day: true, starts_on: '2031-03-14' }),
      );
      assert.equal(day.starts_on, '2031-03-14');
      assert.equal(day.ends_on, '2031-03-15');
      const result = await agenda(
        db,
        user.id,
        at('2031-03-14', '00:00'),
        at('2031-03-15', '00:00'),
      );
      assert.equal(result.events.length, 2);
      assert.ok(ics(result.events).includes('DTSTART;VALUE=DATE:20310314'));
      const ny = await db.tx((c) =>
        createEvent(c, user.id, {
          title: '夏令时全天',
          starts_on: '2031-03-09',
          timezone: 'America/New_York',
        }),
      );
      assert.equal(+new Date(ny.ends_at) - +new Date(ny.starts_at), 23 * 3600000);
    },
  );
  await check(
    'Event rescheduling recomputes relative start/end alerts and preserves absolute times',
    async () => {
      const user = await fixture.user();
      const event = await db.tx((c) =>
        createEvent(c, user.id, {
          title: '原标题',
          starts_at: at('2031-03-14'),
          ends_at: at('2031-03-14', '10:00'),
          reminders: [
            { before_minutes: 30, relative_to: 'start' },
            { title: '结束前提示', before_minutes: 15, relative_to: 'end' },
            { remind_at: at('2031-03-13', '18:00') },
          ],
        }),
      );
      const moved = await db.tx((c) =>
        updateEvent(c, user.id, event.id, {
          title: '新标题',
          starts_at: at('2031-03-14', '11:00'),
          ends_at: at('2031-03-14', '12:00'),
        }),
      );
      assert.equal(
        sqlTime(moved.reminders.find((r: any) => r.relative_to === 'start').remind_at),
        sqlTime(at('2031-03-14', '10:30')),
      );
      assert.equal(
        sqlTime(moved.reminders.find((r: any) => r.relative_to === 'end').remind_at),
        sqlTime(at('2031-03-14', '11:45')),
      );
      assert.equal(
        sqlTime(moved.reminders.find((r: any) => r.trigger_kind === 'absolute').remind_at),
        sqlTime(at('2031-03-13', '18:00')),
      );
      assert.equal(moved.reminders.find((r: any) => r.relative_to === 'start').title, '新标题');
      assert.equal(moved.reminders.find((r: any) => r.relative_to === 'end').title, '结束前提示');
      const cancelled = await db.tx((c) =>
        updateEvent(c, user.id, event.id, { status: 'cancelled' }),
      );
      assert.ok(cancelled.reminders.every((r: any) => r.status === 'cancelled'));
    },
  );
  await check(
    'Task rescheduling and completion update alerts without duplicating tasks or recreating cancelled alerts',
    async () => {
      const user = await fixture.user();
      const task = await db.tx((c) =>
        createTodo(c, user.id, {
          title: '准备材料',
          planned_at: at('2031-03-14'),
          planned_end_at: at('2031-03-14', '10:00'),
          due_at: at('2031-03-20'),
          reminders: [
            { before_minutes: 30, relative_to: 'planned' },
            { before_minutes: 1440, relative_to: 'due' },
            { remind_at: at('2031-03-13', '18:00') },
          ],
        }),
      );
      const moved = await db.tx((c) =>
        updateTodo(c, user.id, task.id, {
          planned_at: at('2031-03-15'),
          planned_end_at: at('2031-03-15', '10:00'),
          due_at: at('2031-03-21'),
        }),
      );
      assert.equal(
        sqlTime(moved.reminders.find((r: any) => r.relative_to === 'planned').remind_at),
        sqlTime(at('2031-03-15', '08:30')),
      );
      assert.equal(
        sqlTime(moved.reminders.find((r: any) => r.relative_to === 'due').remind_at),
        sqlTime(at('2031-03-20')),
      );
      const cleared = await db.tx((c) =>
        updateTodo(c, user.id, task.id, { due_date: '2031-03-21', planned_date: '2031-03-15' }),
      );
      assert.equal(cleared.planned_at, null);
      assert.equal(cleared.planned_end_at, null);
      assert.equal(cleared.due_at, null);
      assert.ok(
        cleared.reminders
          .filter((r: any) => r.trigger_kind === 'relative')
          .every((r: any) => r.status === 'cancelled'),
      );
      const done = await db.tx((c) => updateTodo(c, user.id, task.id, { status: 'done' }));
      assert.ok(done.reminders.every((r: any) => r.status === 'cancelled'));
      const restored = await db.tx((c) => updateTodo(c, user.id, task.id, { status: 'open' }));
      assert.equal(restored.reminders.length, 3);
      assert.ok(restored.reminders.every((r: any) => r.status === 'cancelled'));
      const all = (await db.query('SELECT id FROM todos WHERE user_id=$1', [user.id])).rows;
      assert.deepEqual(
        all.map((t) => t.id),
        [task.id],
      );
    },
  );
  await check(
    'Reminder ownership, absolute/relative changes, date-only anchors and cross-account access are enforced',
    async () => {
      const user = await fixture.user(),
        other = await fixture.user();
      const task = await db.tx((c) =>
        createTodo(c, user.id, { title: '任务', planned_at: at('2031-03-14') }),
      );
      const event = await db.tx((c) =>
        createEvent(c, user.id, { title: '日程', starts_at: at('2031-03-14') }),
      );
      await assert.rejects(() =>
        db.tx((c) =>
          createReminder(c, user.id, {
            title: '双归属',
            event_id: event.id,
            todo_id: task.id,
            before_minutes: 30,
          }),
        ),
      );
      await assert.rejects(() =>
        db.tx((c) =>
          createReminder(c, other.id, {
            title: '越权',
            todo_id: task.id,
            before_minutes: 30,
            relative_to: 'planned',
          }),
        ),
      );
      await assert.rejects(() => getTodo(db, other.id, task.id));
      const alert = await db.tx((c) =>
        createReminder(c, user.id, {
          title: '通知',
          todo_id: task.id,
          before_minutes: 30,
          relative_to: 'planned',
        }),
      );
      const fixed = await db.tx((c) =>
        updateReminder(c, user.id, alert.id, { remind_at: at('2031-03-13', '18:00') }),
      );
      assert.equal(fixed.trigger_kind, 'absolute');
      assert.equal(fixed.relative_to, null);
      assert.equal(fixed.before_minutes, null);
      const moved = await db.tx((c) =>
        updateTodo(c, user.id, task.id, { planned_at: at('2031-03-15') }),
      );
      assert.equal(sqlTime(moved.reminders[0].remind_at), sqlTime(fixed.remind_at));
      const day = await db.tx((c) =>
        createTodo(c, user.id, { title: '只有日期', planned_date: '2031-03-14' }),
      );
      await assert.rejects(() =>
        db.tx((c) =>
          createReminder(c, user.id, {
            title: '不能猜0点',
            todo_id: day.id,
            before_minutes: 30,
            relative_to: 'planned',
          }),
        ),
      );
      await db.tx((c) =>
        createReminder(c, user.id, {
          title: '明确通知时间',
          todo_id: day.id,
          remind_at: at('2031-03-13', '18:00'),
        }),
      );
    },
  );
  await check(
    'Creating/updating an item and its requested alerts is atomic on validation failure',
    async () => {
      const user = await fixture.user();
      await assert.rejects(() =>
        db.tx((c) =>
          createTodo(c, user.id, {
            title: '不能留下半件事',
            planned_date: '2031-03-14',
            reminders: [{ remind_at: '2020-01-01T00:00:00Z' }],
          }),
        ),
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM todos WHERE user_id=$1', [user.id])).rows[0].n,
        0,
      );
      const event = await db.tx((c) =>
        createEvent(c, user.id, { title: '原值', starts_at: at('2031-03-14') }),
      );
      await assert.rejects(() =>
        db.tx((c) =>
          updateEvent(c, user.id, event.id, {
            title: '失败的新值',
            add_reminders: [{ remind_at: '2020-01-01T00:00:00Z' }],
          }),
        ),
      );
      assert.equal(
        (await db.query('SELECT title FROM calendar_events WHERE id=$1', [event.id])).rows[0].title,
        '原值',
      );
    },
  );
  await check(
    'Delivery skips a locked parent and never notifies an already completed task',
    async () => {
      const user = await fixture.user();
      const task = await db.tx((c) =>
        createTodo(c, user.id, {
          title: '提前完成',
          planned_at: at('2030-03-14'),
          reminders: [{ before_minutes: 0, relative_to: 'planned' }],
        }),
      );
      const holder = await db.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM todos WHERE id=$1 FOR UPDATE', [task.id]);
        assert.equal(await deliverReminders(db, new Date(at('2030-03-14', '09:01'))), 0);
        await updateTodo(holder, user.id, task.id, { status: 'done' });
        await holder.query('COMMIT');
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      assert.equal(await deliverReminders(db, new Date(at('2030-03-14', '09:01'))), 0);
      // Also protect historical inconsistent data that predates completion synchronization.
      await db.query("UPDATE reminders SET status='scheduled' WHERE id=$1", [task.reminders[0].id]);
      assert.equal(await deliverReminders(db, new Date(at('2030-03-14', '09:01'))), 0);
      assert.equal(
        (await db.query('SELECT status FROM reminders WHERE id=$1', [task.reminders[0].id])).rows[0]
          .status,
        'cancelled',
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM messages WHERE user_id=$1', [user.id])).rows[0]
          .n,
        0,
      );
    },
  );
  await check(
    'HTTP and actual Agent tools share task fields, ownership, fresh reads and completion behavior',
    async () => {
      const { app } = await createApp(fixture.config, db);
      try {
        const registered = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { name: '日程验收', email: `${randomUUID()}@nota.test`, password: randomUUID() },
        });
        const cookie = registered.headers['set-cookie']!.toString().split(';')[0];
        const request = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any) =>
          app.inject({ method, url, headers: { cookie, 'x-nota-request': '1' }, payload });
        const created = await request('POST', '/api/todos', {
          title: 'HTTP日期待办',
          planned_date: '2031-03-14',
        });
        assert.equal(created.statusCode, 200);
        const task = created.json();
        assert.equal(
          (await request('GET', `/api/todos/${task.id}`)).json().planned_date,
          '2031-03-14',
        );
        const userId = task.user_id;
        const ops = new Operations(db, fixture.config);
        const op = await ops.create(userId, randomUUID(), 'chat', { text: '受控工具验收' });
        const lease = randomUUID();
        await db.query(
          "UPDATE operations SET status='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
          [op.id, lease],
        );
        const tools = buildTools({
          db,
          userId,
          operationId: op.id,
          leaseToken: lease,
          attempt: 1,
          signal: new AbortController().signal,
        } as ToolContext);
        const call = async (name: string, input: any) => {
          const result = await tools.find((t) => t.name === name)!.execute(randomUUID(), input);
          assert.notEqual(result.details.completed, false, result.details.error);
          return result.details;
        };
        await call('update_todo', {
          todo_id: task.id,
          notes: '工具写入备注',
          planned_date: '2031-03-15',
          due_date: '2031-03-20',
          add_reminders: [{ remind_at: at('2031-03-14', '18:00') }],
        });
        const before = await call('get_todo', { todo_id: task.id });
        assert.equal(before.notes, '工具写入备注');
        assert.equal(before.reminders.length, 1);
        await call('update_todo', { todo_id: task.id, status: 'done' });
        const after = await call('get_todo', { todo_id: task.id });
        assert.equal(after.status, 'done');
        assert.equal(after.reminders[0].status, 'cancelled');
        const list = (await request('GET', '/api/todos')).json().todos;
        assert.equal(list[0].reminders[0].status, 'cancelled');
        const exported = await request('GET', '/api/calendar.ics');
        assert.ok(exported.body.includes('BEGIN:VTODO'));
        assert.ok(exported.body.includes('STATUS:COMPLETED'));
        const background = buildTools({
          db,
          userId,
          operationId: op.id,
          leaseToken: lease,
          attempt: 1,
          mode: 'background',
          signal: new AbortController().signal,
        } as ToolContext);
        assert.ok(background.some((t) => t.name === 'get_todo'));
        assert.ok(!background.some((t) => t.name === 'update_todo'));
      } finally {
        await app.close();
      }
    },
  );
  await check(
    'Exports include date-only subjects, tasks and owner alarms without duplicating linked alerts as events',
    async () => {
      const user = await fixture.user();
      const event = await db.tx((c) =>
        createEvent(c, user.id, {
          title: '全天行程',
          starts_on: '2031-03-14',
          reminders: [{ remind_at: at('2031-03-13', '18:00') }],
        }),
      );
      const task = await db.tx((c) =>
        createTodo(c, user.id, {
          title: '任务',
          planned_date: '2031-03-14',
          due_date: '2031-03-20',
          reminders: [{ remind_at: at('2031-03-13', '18:00') }],
        }),
      );
      const text = ics([event], [task], [...event.reminders, ...task.reminders]);
      assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 1);
      assert.equal((text.match(/BEGIN:VTODO/g) ?? []).length, 1);
      assert.equal((text.match(/BEGIN:VALARM/g) ?? []).length, 2);
      assert.ok(text.includes('DUE;VALUE=DATE:20310320'));
    },
  );
  await check(
    'Repeated schema migrations preserve absolute alert mode, dates, identities and unrelated user data',
    async () => {
      const user = await fixture.user();
      const task = await db.tx((c) =>
        createTodo(c, user.id, { title: '保留日期', planned_date: '2031-03-14' }),
      );
      const event = await db.tx((c) =>
        createEvent(c, user.id, {
          title: '保留对象',
          starts_at: at('2031-03-14'),
          reminders: [{ remind_at: at('2031-03-13', '18:00') }],
        }),
      );
      const before = (
        await db.query('SELECT row_to_json(t) AS value FROM reminders t WHERE id=$1', [
          event.reminders[0].id,
        ])
      ).rows[0].value;
      await db.migrate();
      await db.migrate();
      const after = (
        await db.query('SELECT row_to_json(t) AS value FROM reminders t WHERE id=$1', [
          event.reminders[0].id,
        ])
      ).rows[0].value;
      assert.deepEqual(after, before);
      assert.equal((await getTodo(db, user.id, task.id)).planned_date, '2031-03-14');
    },
  );
  await check(
    'A pre-upgrade database migrates without deleting data or inventing new subject times',
    async () => {
      const legacy = await testDatabase();
      try {
        const user = await legacy.user();
        const operation = await new Operations(legacy.db, legacy.config).create(
          user.id,
          randomUUID(),
          'chat',
          { text: '旧数据迁移样例' },
        );
        const eventId = randomUUID(),
          taskId = randomUUID(),
          eventAlertId = randomUUID(),
          taskAlertId = randomUUID();
        await legacy.db.query(
          "INSERT INTO calendar_events(id,user_id,title,starts_at,ends_at,timezone,dedupe_key,operation_id) VALUES($1,$2,'旧日程',$3,$4,'Asia/Shanghai','legacy-event',$5)",
          [eventId, user.id, at('2031-03-14'), at('2031-03-14', '10:00'), operation.id],
        );
        await legacy.db.query(
          "INSERT INTO todos(id,user_id,title,due_at,dedupe_key,operation_id) VALUES($1,$2,'旧待办',$3,'legacy-todo',$4)",
          [taskId, user.id, at('2031-03-20'), operation.id],
        );
        await legacy.db.query(
          "INSERT INTO reminders(id,user_id,title,remind_at,event_id,dedupe_key,operation_id) VALUES($1,$2,'旧日程通知',$3,$4,'legacy-event-alert',$5)",
          [eventAlertId, user.id, at('2031-03-14', '08:30'), eventId, operation.id],
        );
        await legacy.db.query(
          "INSERT INTO reminders(id,user_id,title,remind_at,dedupe_key,operation_id) VALUES($1,$2,'不同标题的旧待办提示',$3,'legacy-todo-alert',$4)",
          [taskAlertId, user.id, at('2031-03-20'), operation.id],
        );
        await legacy.db.tx(async (c) => {
          await c.query(
            'ALTER TABLE todos DROP COLUMN timezone,DROP COLUMN planned_date,DROP COLUMN planned_at,DROP COLUMN planned_end_at,DROP COLUMN due_date',
          );
          await c.query(
            'ALTER TABLE calendar_events DROP COLUMN all_day,DROP COLUMN starts_on,DROP COLUMN ends_on',
          );
          await c.query('ALTER TABLE calendar_events ALTER COLUMN ends_at SET NOT NULL');
          await c.query(
            'ALTER TABLE reminders DROP COLUMN trigger_kind,DROP COLUMN relative_to,DROP COLUMN before_minutes',
          );
          await c.query('DELETE FROM schema_migrations WHERE version=4');
        });
        await legacy.db.migrate();
        await legacy.db.migrate();
        const alerts = (
          await legacy.db.query('SELECT * FROM reminders WHERE user_id=$1 ORDER BY id', [user.id])
        ).rows;
        assert.equal(alerts.find((r) => r.id === eventAlertId).before_minutes, 30);
        assert.equal(alerts.find((r) => r.id === eventAlertId).trigger_kind, 'relative');
        assert.equal(alerts.find((r) => r.id === taskAlertId).todo_id, taskId);
        assert.equal(alerts.find((r) => r.id === taskAlertId).trigger_kind, 'absolute');
        const task = await getTodo(legacy.db, user.id, taskId);
        assert.equal(sqlTime(task.due_at), sqlTime(at('2031-03-20')));
        assert.equal(task.planned_date, null);
        assert.equal(
          (
            await legacy.db.query('SELECT count(*)::int n FROM calendar_events WHERE user_id=$1', [
              user.id,
            ])
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await legacy.db.query('SELECT count(*)::int n FROM operations WHERE user_id=$1', [
              user.id,
            ])
          ).rows[0].n,
          1,
        );
      } finally {
        await legacy.close();
      }
    },
  );
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/agenda-integration.json',
    JSON.stringify({ passed: results.length, results }, null, 2),
  );
} finally {
  await fixture.close();
}
