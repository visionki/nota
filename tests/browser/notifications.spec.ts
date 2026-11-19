import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { backgroundFixture } from '../background-fixture.js';
import { notify } from '../../src/server/notifications.js';
import { deliverReminders } from '../../src/server/scheduler.js';

test('Notifications distinguish events, locate old results, and keep read and resolved states separate', async ({
  page,
}, testInfo) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `notifications-${randomUUID()}@nota.test`,
        name: '通知验收',
        password: randomUUID(),
      },
    });
    expect(registration.ok()).toBe(true);
    const userId = (await registration.json()).user.id;
    const reminderId = randomUUID();
    await f.db.query(
      "INSERT INTO reminders(id,user_id,title,remind_at,dedupe_key) VALUES($1,$2,'看牙前一天提醒',now()-interval '1 second',$3)",
      [reminderId, userId, reminderId],
    );
    await deliverReminders(f.db);
    const history = async (prefix: string) =>
      f.db.tx(async (c) => {
        for (let n = 0; n < 80; n++)
          await c.query(
            "INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,'user',$3,$4)",
            [randomUUID(), userId, `日常交办 ${prefix} ${n}`, `${prefix}:${n}`],
          );
      });
    await history('before-result');
    const resultMessage = randomUUID();
    await f.db.tx(async (c) => {
      await c.query(
        "INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,'assistant','trigger','本周报告已经整理好，新增了三项进展。','weekly-result')",
        [resultMessage, userId],
      );
      await notify(c, userId, 'weekly-result', {
        kind: 'task_result',
        title: '本周报告已整理',
        body: '**新增三项进展**，请查看[报告来源](https://example.com/report)。',
        messageId: resultMessage,
      });
    });
    await history('after-result');
    const waiting = await f.runtime.ops.create(userId, randomUUID(), 'trigger', {
      source: 'recording_window',
      text: '陈总身份确认',
    });
    const questionMessage = randomUUID();
    await f.db.tx(async (c) => {
      await c.query(
        "UPDATE operations SET status='waiting',stage='waiting',reply='请确认陈总是哪家公司。' WHERE id=$1",
        [waiting.id],
      );
      await c.query(
        "INSERT INTO messages(id,user_id,operation_id,role,kind,content,dedupe_key) VALUES($1,$2,$3,'assistant','trigger','请确认陈总是哪家公司。',$4)",
        [questionMessage, userId, waiting.id, `${waiting.id}:response:0`],
      );
      await notify(c, userId, 'contact-question', {
        kind: 'attention',
        title: '确认联系人后才能继续',
        body: '请确认陈总是哪家公司。',
        objectId: waiting.id,
        messageId: questionMessage,
      });
    });
    const list = async () =>
      (await (await page.request.get(`${f.base}/api/notifications`)).json()).notifications;
    const rows = await list(),
      reminder = rows.find((n: any) => n.kind === 'reminder'),
      attention = rows.find((n: any) => n.kind === 'attention');
    await page.goto(`${f.base}/#notifications`);
    await expect(page.locator('.notification-row')).toHaveCount(3);
    await expect(
      page.locator('.notification-meta').getByText('到时提醒', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.notification-meta').getByText('任务结果', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.notification-meta').getByText('待你处理', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('新增三项进展，请查看报告来源。', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-notifications.png`,
      fullPage: true,
    });
    await page
      .locator('.notification-tabs')
      .getByRole('button', { name: '到时提醒', exact: true })
      .click();
    await expect(page.locator('.notification-row')).toHaveCount(1);
    await page.locator('.notification-row').click();
    await expect(page).toHaveURL(`${f.base}/#chat/${reminder.message_id}`);
    await expect(page.locator(`[data-message-id="${reminder.message_id}"]`)).toBeInViewport();
    await expect
      .poll(async () => (await list()).find((n: any) => n.id === reminder.id).read_at)
      .toBeTruthy();
    // The pending question is in another history page and has not been viewed.
    expect((await list()).find((n: any) => n.id === attention.id).read_at).toBe(null);
    await page.goto(`${f.base}/#notifications`);
    await page
      .locator('.notification-tabs')
      .getByRole('button', { name: '任务结果', exact: true })
      .click();
    await page.locator('.notification-row').click();
    await expect(page.locator(`[data-message-id="${resultMessage}"]`)).toBeInViewport();
    await page.goto(`${f.base}/#notifications`);
    await page
      .locator('.notification-tabs')
      .getByRole('button', { name: '待你处理', exact: true })
      .click();
    await page.locator('.notification-row').click();
    await expect(page.locator(`[data-message-id="${questionMessage}"]`)).toBeInViewport();
    expect((await list()).find((n: any) => n.id === attention.id).resolved_at).toBe(null);
    const composer = page.getByRole('textbox', { name: '发送给 Nota' });
    await composer.fill('星河科技的陈总');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(async () => (await list()).find((n: any) => n.id === attention.id).resolved_at)
      .toBeTruthy();
    await f.runtime.processUser(userId);
    await page.goto(`${f.base}/#notifications`);
    await expect(
      page.locator(`[data-notification-id="${attention.id}"]`).getByText('已处理', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '全部已读', exact: true }).click();
    await expect(page.locator('.notification-row .unread-dot')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-notifications-resolved.png`,
      fullPage: true,
    });
    expect(f.errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});

test('A foreground failure notification opens its message and retry action in chat', async ({
  page,
}) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `failed-notification-${randomUUID()}@nota.test`,
        name: '失败通知验收',
        password: randomUUID(),
      },
    });
    const userId = (await registration.json()).user.id;
    const op = await f.runtime.ops.submit(userId, randomUUID(), '需要重试的查询');
    const original = f.runtime.agent.run;
    f.runtime.agent.run = async () => {
      throw new Error('尚未配置受控查询服务');
    };
    try {
      await f.runtime.processUser(userId);
    } finally {
      f.runtime.agent.run = original;
    }
    const notice = (await (await page.request.get(`${f.base}/api/notifications`)).json())
      .notifications[0];
    await page.goto(`${f.base}/#notifications`);
    await page.locator('.notification-row').click();
    await expect(page).toHaveURL(`${f.base}/#chat/${notice.message_id}`);
    await expect(page.getByRole('button', { name: '重试这次交办', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试这次交办', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await f.db.query('SELECT status FROM operations WHERE id=$1', [op.id])).rows[0].status,
      )
      .toBe('queued');
    await f.runtime.processUser(userId);
    await expect(page.getByText('前台聊天已回复：需要重试的查询', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试这次交办', exact: true })).toHaveCount(0);
    expect(
      (await (await page.request.get(`${f.base}/api/background-tasks?scope=all`)).json()).tasks,
    ).toHaveLength(0);
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});

test('Automatic tasks expose notification policy and a schedule incident locates its controls', async ({
  page,
}, testInfo) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `notification-policy-${randomUUID()}@nota.test`,
        name: '通知策略验收',
        password: randomUUID(),
      },
    });
    const userId = (await registration.json()).user.id;
    await page.goto(`${f.base}/#agenda`);
    await page.getByRole('button', { name: '自动任务', exact: true }).click();
    await page.getByRole('button', { name: '新建自动任务', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('标题', { exact: true }).fill('公告变化监控');
    await dialog
      .getByLabel('到时交给 Nota 的任务', { exact: true })
      .fill('查看星河科技公告，有新变化才告知。');
    await dialog.getByLabel('结果通知').selectOption('on_change');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const schedules = async () =>
      (await (await page.request.get(`${f.base}/api/schedules`)).json()).schedules;
    await expect.poll(async () => (await schedules())[0]?.notification_policy).toBe('on_change');
    const schedule = (await schedules())[0];
    await page.getByLabel('公告变化监控的结果通知').selectOption('always');
    await expect.poll(async () => (await schedules())[0].notification_policy).toBe('always');
    expect(
      (await (await page.request.get(`${f.base}/api/notifications`)).json()).notifications,
    ).toHaveLength(0);
    await f.db.tx((c) =>
      notify(c, userId, 'schedule-incident', {
        kind: 'attention',
        title: '自动任务未执行：公告变化监控',
        body: '可用额度不足，请检查任务。',
        objectId: schedule.id,
        objectType: 'schedule',
      }),
    );
    await page.goto(`${f.base}/#notifications`);
    await page.locator('.notification-row').click();
    await expect(page).toHaveURL(`${f.base}/#agenda/schedule:${schedule.id}`);
    await expect(page.getByLabel('公告变化监控的结果通知')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-notification-policy.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});
