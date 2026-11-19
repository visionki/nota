import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../helpers.js';
import { createApp } from '../../src/server/app.js';
import { localInput, zonedISO } from '../../src/web/api.js';
import { addDays } from '../../src/web/calendar.js';

test('Month and week share real arrangements, notifications and overnight events on desktop and mobile', async ({
  page,
}, testInfo) => {
  const fixture = await testDatabase();
  const { app } = await createApp(fixture.config, fixture.db);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  fixture.config.APP_URL = base;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const target = addDays(localInput(new Date(), 'Asia/Shanghai').slice(0, 10), 2);
  const endDay = addDays(target, 1);
  const at = (day: string, time: string) => zonedISO(`${day}T${time}`, 'Asia/Shanghai');
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(base + '/api' + path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: '第一次来？创建账号' }).click();
    await page.getByLabel('怎么称呼你').fill('日历验收');
    await page.getByLabel('邮箱', { exact: true }).fill(`calendar-${randomUUID()}@nota.test`);
    await page.getByLabel('密码', { exact: true }).fill(randomUUID());
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送给 Nota' })).toBeVisible();
    const wake = (
      await post('/arrangements', {
        kind: 'reminder',
        title: '叫我起床',
        starts_at: at(target, '06:00'),
      })
    ).reminder;
    const dentist = await post('/arrangements', {
      title: '看牙齿',
      starts_at: at(target, '09:00'),
      ends_at: at(target, '10:00'),
      before_minutes: 30,
    });
    await post('/calendar', {
      title: '方案评审',
      starts_at: at(target, '09:30'),
      ends_at: at(target, '10:30'),
    });
    const overnight = await post('/calendar', {
      title: '跨天安排',
      starts_at: at(target, '23:00'),
      ends_at: at(endDay, '01:00'),
    });
    if ((page.viewportSize()?.width ?? 1000) <= 650)
      await page.getByRole('button', { name: '打开菜单', exact: true }).click();
    await page
      .locator('.main-nav')
      .getByRole('button', { name: '日程与待办', exact: false })
      .click();
    const calendar = page.locator('.agenda-calendar');
    await expect(calendar.getByRole('button', { name: '月视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const cells = await calendar.locator('.agenda-month-cell').count();
    expect(cells).toBeGreaterThanOrEqual(35);
    expect(cells % 7).toBe(0);
    await calendar.locator(`.agenda-month-cell[data-date="${target}"] .agenda-month-date`).click();
    await expect(calendar.locator('.agenda-day-panel')).toContainText('4 项安排');
    await expect(calendar.locator('.agenda-day-items')).toContainText('叫我起床');
    await expect(calendar.locator('.agenda-day-items')).toContainText('06:00');
    await expect(calendar.locator(`[data-item-id="reminder:${dentist.reminder.id}"]`)).toHaveCount(
      0,
    );
    await expect(
      calendar.locator(
        `.agenda-month-cell[data-date="${endDay}"] [data-item-id="event:${overnight.id}"]`,
      ),
    ).toHaveCount(1);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-calendar-month.png`,
      fullPage: true,
    });
    await calendar.getByRole('button', { name: '周视图', exact: true }).click();
    await expect(calendar.getByRole('button', { name: '周视图', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const week = calendar.locator(`.agenda-week-column[data-date="${target}"]`);
    const point = week.locator(`[data-item-id="reminder:${wake.id}"]`);
    const event = week.locator(`[data-item-id="event:${dentist.event.id}"]`);
    await expect(point).toHaveCount(1);
    await expect(event).toHaveCount(1);
    expect(await point.evaluate((element) => parseFloat((element as HTMLElement).style.top))).toBe(
      396,
    );
    expect(await event.evaluate((element) => parseFloat((element as HTMLElement).style.top))).toBe(
      588,
    );
    expect(await event.evaluate((element) => (element as HTMLElement).style.width)).toContain(
      '50%',
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-calendar-week.png`,
      fullPage: true,
    });
    await event.click();
    await page.getByRole('dialog').getByRole('button', { name: '修改', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('combobox', { name: '提醒方式', exact: true })
      .selectOption('absolute');
    await page
      .getByRole('dialog')
      .getByLabel(/提醒时间/)
      .fill(`${target}T08:15`);
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const notification = (
      await fixture.db.query('SELECT event_id,remind_at FROM reminders WHERE id=$1', [
        dentist.reminder.id,
      ])
    ).rows[0];
    expect(notification.event_id).toBe(dentist.event.id);
    expect(new Date(notification.remind_at).toISOString()).toBe(at(target, '08:15'));
    await point.click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('待通知');
    await dialog.getByRole('button', { name: '编辑提醒', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/提醒时间/)).toHaveValue(`${target}T06:00`);
    await dialog.getByLabel('标题', { exact: true }).fill('叫我起床（已调整）');
    await dialog.getByLabel(/提醒时间/).fill(`${target}T07:00`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(week.locator(`[data-item-id="reminder:${wake.id}"]`)).toHaveAttribute(
      'aria-label',
      new RegExp('07:00 叫我起床'),
    );
    const rows = await fixture.db.query('SELECT id FROM reminders WHERE title=$1', [
      '叫我起床（已调整）',
    ]);
    expect(rows.rows.map((row) => row.id)).toEqual([wake.id]);
    await page.getByRole('button', { name: '新建事项', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('取快递');
    await dialog.getByRole('button', { name: '独立提醒', exact: true }).click();
    await dialog.getByLabel('提醒时间', { exact: true }).fill(`${target}T18:00`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(week.getByRole('button', { name: new RegExp('18:00 取快递') })).toHaveCount(1);
    await week.getByRole('button', { name: new RegExp('18:00 取快递') }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消安排', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(week.getByRole('button', { name: new RegExp('18:00 取快递') })).toHaveCount(0);
    await page.getByRole('button', { name: '新建事项', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('晚间散步');
    await dialog.getByLabel('全天 / 仅日期', { exact: true }).uncheck();
    await dialog.getByLabel('开始时间', { exact: true }).fill(`${target}T20:00`);
    await dialog.getByLabel('结束时间（可选）', { exact: true }).fill(`${target}T21:00`);
    await dialog.getByRole('combobox', { name: '提醒我', exact: true }).selectOption('15');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    const walk = (
      await fixture.db.query('SELECT id FROM calendar_events WHERE title=$1', ['晚间散步'])
    ).rows;
    expect(walk).toHaveLength(1);
    const walkReminders = (
      await fixture.db.query('SELECT id FROM reminders WHERE event_id=$1', [walk[0].id])
    ).rows;
    expect(walkReminders).toHaveLength(1);
    await expect(week.locator(`[data-item-id="event:${walk[0].id}"]`)).toHaveCount(1);
    await expect(calendar.locator(`[data-item-id="reminder:${walkReminders[0].id}"]`)).toHaveCount(
      0,
    );
    await calendar.getByRole('button', { name: '月视图', exact: true }).click();
    await calendar.getByRole('button', { name: '下一月', exact: true }).click();
    await expect(calendar.getByRole('button', { name: '上一月', exact: true })).toBeVisible();
    await calendar.getByRole('button', { name: '今天', exact: true }).click();
    await expect(calendar.locator('.agenda-month-cell.is-today')).toHaveClass(/is-selected/);
    if (testInfo.project.name === 'h5') {
      await page.setViewportSize({ width: 320, height: 844 });
      await expect(calendar.locator('.agenda-day-panel')).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect(errors).toEqual([]);
  } finally {
    try {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    } finally {
      app.server.closeAllConnections();
      await app.close();
      await fixture.close();
    }
  }
});
