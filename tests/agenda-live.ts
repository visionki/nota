/** Opt-in real Pi/GMI acceptance. Synthetic prompts and an isolated temporary database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { testDatabase } from './helpers.js';
import { loadConfig, safeError } from '../src/server/config.js';
import { Runtime } from '../src/server/runtime.js';

const fixture = await testDatabase(),
  actual = loadConfig();
const config = {
  ...fixture.config,
  GMI_API_KEY: actual.GMI_API_KEY,
  GMI_BASE_URL: actual.GMI_BASE_URL,
  GMI_MODEL: actual.GMI_MODEL,
  EMBEDDING_ENABLED: false,
  MAX_RUN_SECONDS: 180,
};
const runtime = new Runtime(fixture.db, config);
const report: any = { at: new Date().toISOString(), complete: false, checks: [] };
try {
  assert(config.GMI_API_KEY, 'GMI_API_KEY required');
  const user = await fixture.user('事项模型真实验收');
  const ask = async (name: string, text: string, verify: () => Promise<void>) => {
    const op = await runtime.ops.submit(user.id, randomUUID(), text);
    await runtime.processUser(user.id);
    const result = (
      await fixture.db.query('SELECT status,reply,last_error FROM operations WHERE id=$1', [op.id])
    ).rows[0];
    assert.equal(result.status, 'succeeded', result.last_error ?? result.reply);
    await verify();
    const tools = (
      await fixture.db.query(
        'SELECT name,input,status FROM tool_calls WHERE operation_id=$1 ORDER BY started_at',
        [op.id],
      )
    ).rows;
    report.checks.push({ name, reply: result.reply, tools });
    console.log(`PASS ${name}`);
  };
  const tasks = async () =>
    (await fixture.db.query('SELECT * FROM todos WHERE user_id=$1', [user.id])).rows;
  const events = async () =>
    (
      await fixture.db.query('SELECT * FROM calendar_events WHERE user_id=$1 ORDER BY created_at', [
        user.id,
      ])
    ).rows;
  const alerts = async () =>
    (
      await fixture.db.query('SELECT * FROM reminders WHERE user_id=$1 ORDER BY created_at', [
        user.id,
      ])
    ).rows;
  await ask(
    'An unbooked action with only a date becomes a planned task without a deadline or alert',
    '请记录一个待办：2031年3月14日去拔智齿，目前尚未预约。只有日期，无截止日期，不要设置提醒。',
    async () => {
      const rows = await tasks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].planned_date, '2031-03-14');
      assert.equal(rows[0].planned_at, null);
      assert.equal(rows[0].due_at, null);
      assert.equal(rows[0].due_date, null);
      assert.equal((await events()).length, 0);
      assert.equal((await alerts()).length, 0);
    },
  );
  await ask(
    'A booked event does not require a fabricated end time or a duplicate task',
    '再记录已约好的日程：2031年3月15日上午9点与陈总吃饭，结束时间不知道，不需要提醒。',
    async () => {
      const rows = await events();
      assert.equal(rows.length, 1);
      assert.equal(new Date(rows[0].starts_at).toISOString(), '2031-03-15T01:00:00.000Z');
      assert.equal(rows[0].ends_at, null);
      assert.equal((await tasks()).length, 1);
    },
  );
  await ask(
    'The Agent reads and updates the original task, with a fixed alert attached to it',
    '给拔智齿那条待办设置2031年3月13日下午6点的固定提醒，并把计划日期改为2031年3月16日；不要新建待办或日程。',
    async () => {
      assert.equal((await tasks()).length, 1);
      assert.equal((await tasks())[0].planned_date, '2031-03-16');
      const rows = await alerts();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].todo_id, (await tasks())[0].id);
      assert.equal(rows[0].trigger_kind, 'absolute');
      assert.equal(new Date(rows[0].remind_at).toISOString(), '2031-03-13T10:00:00.000Z');
    },
  );
  await ask(
    'Completing the task automatically cancels its future alert',
    '我已经拔完智齿了，把那条待办标记完成。',
    async () => {
      assert.equal((await tasks())[0].status, 'done');
      assert.equal((await alerts())[0].status, 'cancelled');
    },
  );
  await ask(
    'An all-day commitment keeps date precision',
    '2031年3月17日我全天出差，帮我记成全天日程，不要设置提醒。',
    async () => {
      const rows = await events();
      assert.equal(rows.length, 2);
      assert.equal(rows[1].all_day, true);
      assert.equal(rows[1].starts_on, '2031-03-17');
      assert.equal(rows[1].ends_on, '2031-03-18');
    },
  );
  await ask(
    'A pure wake-up request stays an independent alert',
    '2031年3月18日上午6点叫醒我，仅需一次通知，不要创建日程和待办。',
    async () => {
      const rows = await alerts();
      assert.equal(rows.length, 2);
      assert.equal(rows[1].event_id, null);
      assert.equal(rows[1].todo_id, null);
      assert.equal((await tasks()).length, 1);
      assert.equal((await events()).length, 2);
    },
  );
  report.complete = true;
} catch (error) {
  report.error = safeError(error, config);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await runtime.stop();
  await fixture.close();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/agenda-live.json', JSON.stringify(report, null, 2));
}
