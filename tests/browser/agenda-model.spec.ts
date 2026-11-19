import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../helpers.js';
import { createApp } from '../../src/server/app.js';
import { localInput } from '../../src/web/api.js';
import { addDays } from '../../src/web/calendar.js';

test('Calendar and lists share tasks, exact date precision and alert lifecycle on desktop and mobile', async ({
  page,
}, info) => {
  const fixture = await testDatabase();
  const { app } = await createApp(fixture.config, fixture.db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  fixture.config.APP_URL = base;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const target = addDays(localInput(new Date(), 'Asia/Shanghai').slice(0, 10), 2);
  const deadline = addDays(target, 3);
  try {
    await page.goto(base);
    await page.getByRole('button', { name: '第一次来？创建账号' }).click();
    await page.getByLabel('怎么称呼你').fill('事项验收');
    await page.getByLabel('邮箱', { exact: true }).fill(`agenda-${randomUUID()}@nota.test`);
    await page.getByLabel('密码', { exact: true }).fill(randomUUID());
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送给 Nota' })).toBeVisible();
    if (info.project.name === 'h5')
      await page.getByRole('button', { name: '打开菜单', exact: true }).click();
    await page
      .locator('.main-nav')
      .getByRole('button', { name: '日程与待办', exact: false })
      .click();
    const calendar = page.locator('.agenda-calendar');
    const select = async (day: string) =>
      calendar.locator(`.agenda-month-cell[data-date="${day}"] .agenda-month-date`).click();
    await select(target);
    await page.getByRole('button', { name: '新建事项', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '待办', exact: true }).click();
    await dialog.getByLabel('标题', { exact: true }).fill('两周后拔智齿');
    await dialog.getByLabel('计划日期（可选）', { exact: true }).fill(target);
    await dialog.getByLabel('截止日期（可选）', { exact: true }).fill(deadline);
    await dialog.getByRole('combobox', { name: '提醒我', exact: true }).selectOption('absolute');
    await dialog.getByLabel('提醒时间', { exact: true }).fill(`${addDays(target, -1)}T18:00`);
    await page.screenshot({
      path: `test-results/agenda-model-${info.project.name}-editor.png`,
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    const task = (await fixture.db.query("SELECT * FROM todos WHERE title='两周后拔智齿'")).rows[0];
    expect(task.planned_date).toBe(target);
    expect(task.planned_at).toBeNull();
    expect(task.due_date).toBe(deadline);
    expect(task.due_at).toBeNull();
    const alert = (await fixture.db.query('SELECT * FROM reminders WHERE todo_id=$1', [task.id]))
      .rows[0];
    expect(alert.trigger_kind).toBe('absolute');
    await expect(calendar.locator('.agenda-day-panel')).toContainText('1 项安排');
    await expect(
      calendar.locator(`.agenda-day-items [data-item-id="todo:${task.id}"]`),
    ).toContainText('全天');
    await expect(calendar.locator(`[data-item-id="reminder:${alert.id}"]`)).toHaveCount(0);
    await select(addDays(target, -1));
    await expect(calendar.locator('.agenda-day-panel')).toContainText('0 项安排');
    await select(deadline);
    await expect(calendar.locator('.agenda-day-items')).toContainText('截止 · 两周后拔智齿');
    await select(target);
    await calendar
      .locator('.agenda-day-panel')
      .getByRole('checkbox', { name: '完成待办 两周后拔智齿', exact: true })
      .click();
    await expect(calendar.locator('.agenda-day-panel')).toContainText('0 项安排');
    expect(
      (await fixture.db.query('SELECT status FROM reminders WHERE id=$1', [alert.id])).rows[0]
        .status,
    ).toBe('cancelled');
    await calendar.getByRole('checkbox', { name: '显示已完成', exact: true }).check();
    await expect(calendar.locator('.agenda-day-panel .agenda-day-entry')).toHaveClass(/is-done/);
    await calendar
      .locator('.agenda-day-panel')
      .getByRole('checkbox', { name: '恢复待办 两周后拔智齿', exact: true })
      .click();
    await expect(calendar.locator('.agenda-day-panel .agenda-day-entry')).not.toHaveClass(
      /is-done/,
    );
    expect(
      (
        await fixture.db.query(
          "SELECT count(*)::int n FROM reminders WHERE todo_id=$1 AND status='scheduled'",
          [task.id],
        )
      ).rows[0].n,
    ).toBe(0);
    await calendar.getByRole('checkbox', { name: '显示已完成', exact: true }).uncheck();

    await page.getByRole('button', { name: '新建事项', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('已预约看牙（结束待定）');
    await dialog.getByLabel('全天 / 仅日期', { exact: true }).uncheck();
    await dialog.getByLabel('开始时间', { exact: true }).fill(`${target}T09:00`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    const event = (
      await fixture.db.query("SELECT * FROM calendar_events WHERE title='已预约看牙（结束待定）'")
    ).rows[0];
    expect(event.ends_at).toBeNull();
    expect(
      (await fixture.db.query('SELECT id FROM reminders WHERE event_id=$1', [event.id])).rows,
    ).toHaveLength(0);
    await expect(calendar.locator('.agenda-day-panel')).toContainText('2 项安排');

    await page.getByRole('button', { name: '新建事项', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('全天出差');
    await dialog.getByLabel('开始日期', { exact: true }).fill(target);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(calendar.locator('.agenda-day-panel')).toContainText('3 项安排');
    await page.screenshot({
      path: `test-results/agenda-model-${info.project.name}-month.png`,
      fullPage: true,
    });

    await page.getByRole('button', { name: '全部事项', exact: true }).click();
    await expect(page.locator('.agenda-all-list')).toContainText('全天出差');
    await expect(page.locator('.agenda-all-list')).toContainText('截止 · 两周后拔智齿');
    await expect(page.locator('.agenda-all-list [data-item-id^="reminder:"]')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/agenda-model-${info.project.name}-list.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: /^待办事项/ }).click();
    await expect(page.locator('.todo-row')).toHaveCount(1);
    await expect(page.locator('.todo-row')).toContainText('计划');
    await expect(page.locator('.todo-row')).toContainText('截止');
    await page.locator('.todo-content').click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('指定执行时刻', { exact: true }).check();
    await dialog.getByLabel('计划日期（可选）', { exact: true }).fill(`${target}T14:00`);
    await dialog.getByLabel('计划结束时间（可选）', { exact: true }).fill(`${target}T15:00`);
    await dialog.getByRole('combobox', { name: '提醒我', exact: true }).selectOption('30');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(
      (await fixture.db.query('SELECT planned_date FROM todos WHERE id=$1', [task.id])).rows[0]
        .planned_date,
    ).toBeNull();
    expect(
      (
        await fixture.db.query(
          "SELECT relative_to FROM reminders WHERE todo_id=$1 AND status='scheduled'",
          [task.id],
        )
      ).rows[0].relative_to,
    ).toBe('planned');
    await page.getByRole('button', { name: '日历', exact: true }).click();
    await calendar.getByRole('button', { name: '周视图', exact: true }).click();
    await expect(
      calendar.locator(
        `.agenda-week-column[data-date="${target}"] [data-item-id="todo:${task.id}"]`,
      ),
    ).toHaveCount(1);
    await expect(calendar.locator('.agenda-week-all-day')).toContainText('全天出差');
    await page.screenshot({
      path: `test-results/agenda-model-${info.project.name}-week.png`,
      fullPage: true,
    });
    if (info.project.name === 'h5') await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect((await (await page.request.get(base + '/api/usage')).json()).used).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    app.server.closeAllConnections();
    await app.close();
    await fixture.close();
  }
});
