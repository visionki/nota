import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { Db, emit } from './db.js';
import { Operations } from './quota.js';
import { notify, resolveNotifications } from './notifications.js';
export async function deliverReminders(db: Db, now = new Date()) {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      "SELECT id,user_id,event_id,todo_id FROM reminders WHERE status='scheduled' AND remind_at<=$1 ORDER BY remind_at LIMIT 100",
      [now],
    );
    let delivered = 0;
    for (const candidate of rows) {
      let active = true;
      if (candidate.event_id || candidate.todo_id) {
        const event = !!candidate.event_id;
        const parent = (
          await c.query(
            `SELECT status FROM ${event ? 'calendar_events' : 'todos'} WHERE id=$1 AND user_id=$2 FOR UPDATE SKIP LOCKED`,
            [candidate.event_id ?? candidate.todo_id, candidate.user_id],
          )
        ).rows[0];
        if (!parent) continue;
        active = parent.status === (event ? 'confirmed' : 'open');
      }
      const r = (
        await c.query(
          "SELECT * FROM reminders WHERE id=$1 AND status='scheduled' AND remind_at<=$2 FOR UPDATE SKIP LOCKED",
          [candidate.id, now],
        )
      ).rows[0];
      if (!r) continue;
      if (r.event_id !== candidate.event_id || r.todo_id !== candidate.todo_id) continue;
      if (!active) {
        await c.query("UPDATE reminders SET status='cancelled' WHERE id=$1", [r.id]);
        await emit(c, r.user_id, 'changed', { entity: 'reminder', id: r.id });
        continue;
      }
      const key = `reminder:${r.id}`;
      const message = await c.query(
        'INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET content=EXCLUDED.content RETURNING id',
        [
          randomUUID(),
          r.user_id,
          'assistant',
          'reminder',
          `⏰ ${r.title}\n\n这是你设置的到点提醒。`,
          key,
        ],
      );
      await notify(c, r.user_id, key, {
        kind: 'reminder',
        title: r.title,
        body: '你设置的提醒时间到了。',
        objectId: r.event_id ?? r.todo_id ?? r.id,
        objectType: r.event_id ? 'event' : r.todo_id ? 'todo' : 'reminder',
        messageId: message.rows[0].id,
      });
      await c.query("UPDATE reminders SET status='delivered',delivered_at=$2 WHERE id=$1", [
        r.id,
        now,
      ]);
      await emit(c, r.user_id, 'changed', { entity: 'reminder', id: r.id });
      delivered++;
    }
    return delivered;
  });
}
export async function activateSchedules(db: Db, ops: Operations, now = new Date()) {
  return db.tx(async (c) => {
    const rows = (
      await c.query(
        'SELECT * FROM schedules WHERE active AND next_run_at<=$1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 30',
        [now],
      )
    ).rows;
    for (const s of rows) {
      const key = `schedule:${s.id}:${new Date(s.next_run_at).toISOString()}`;
      await c.query('SAVEPOINT activation');
      try {
        await ops.create(
          s.user_id,
          key,
          'trigger',
          {
            text: s.prompt,
            source: 'schedule',
            schedule_id: s.id,
            schedule_title: s.title,
            notification_policy: s.notification_policy,
            triggered_at: new Date(s.next_run_at).toISOString(),
          },
          c,
          now,
        );
        await resolveNotifications(c, s.user_id, s.id, 'schedule');
        await c.query('RELEASE SAVEPOINT activation');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT activation');
        // One unresolved incident per schedule; repeated failed activations do not flood the inbox.
        const pending = await c.query(
          "SELECT id FROM notifications WHERE user_id=$1 AND object_id=$2 AND object_type='schedule' AND kind='attention' AND resolved_at IS NULL AND archived_at IS NULL",
          [s.user_id, s.id],
        );
        if (!pending.rowCount)
          await notify(c, s.user_id, `${key}:failure:${randomUUID()}`, {
            kind: 'attention',
            title: `自动任务未执行：${s.title}`,
            body: `${e instanceof Error ? e.message : '无法创建任务'}。请检查自动任务或可用额度。`,
            objectId: s.id,
            objectType: 'schedule',
          });
      }
      let next: Date | null = null;
      if (s.cron) {
        try {
          next = CronExpressionParser.parse(s.cron, { tz: s.timezone, currentDate: now })
            .next()
            .toDate();
        } catch {}
      }
      await c.query(
        'UPDATE schedules SET active=$2,next_run_at=coalesce($3,next_run_at),last_run_at=$4 WHERE id=$1',
        [s.id, !!next, next, now],
      );
      await emit(c, s.user_id, 'changed', { entity: 'schedule', id: s.id });
    }
    return rows.length;
  });
}
