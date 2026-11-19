import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { backgroundFixture } from '../background-fixture.js';
import { activateSchedules } from '../../src/server/scheduler.js';

test('Scheduled research keeps the composer free, reports through Nota once, and restores after reload', async ({
  page,
}, testInfo) => {
  const f = await backgroundFixture(true);
  const hold = f.hold('task:browser-background-case');
  try {
    const response = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `background-${randomUUID()}@nota.test`,
        name: '后台任务验收',
        password: randomUUID(),
      },
    });
    expect(response.ok()).toBe(true);
    const userId = (await response.json()).user.id;
    await page.goto(f.base);
    const input = page.getByRole('textbox', { name: '发送给 Nota' });
    await expect(input).toBeVisible();
    await f.db.query(
      "INSERT INTO schedules(id,user_id,title,prompt,next_run_at) VALUES($1,$2,'查询最新公告','browser-background-case',now()-interval '1 second')",
      [randomUUID(), userId],
    );
    await activateSchedules(f.db, f.runtime.ops);
    await hold.started.wait;
    await expect(page.locator('.composer-note')).toContainText('一个持续的对话');
    await expect(page.getByText('browser-background-case', { exact: true })).toHaveCount(0);
    await input.fill('后台查询时我继续聊');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      page.getByText('前台聊天已回复：后台查询时我继续聊', { exact: true }),
    ).toBeVisible();
    const research = (
      await f.db.query("SELECT * FROM operations WHERE user_id=$1 AND executor='background'", [
        userId,
      ])
    ).rows[0];
    expect(research.status).toBe('running');
    await page.reload();
    await expect(input).toBeVisible();
    await expect(page.locator('.composer-note')).toContainText('一个持续的对话');
    hold.release.open();
    await expect(page.getByText(/后台任务结果：已核实公告/)).toBeVisible();
    await expect(page.getByRole('link', { name: '官方来源', exact: true })).toHaveAttribute(
      'href',
      'https://example.com/notice',
    );
    await expect.poll(async () => (await f.runtime.ops.usage(userId)).used).toBe(2);
    expect((await f.runtime.ops.usage(userId)).reserved).toBe(0);
    await page.reload();
    await expect(page.getByText(/后台任务结果：已核实公告/)).toHaveCount(1);
    await expect(page.getByText('RAW_SEARCH_ONLY', { exact: false })).toHaveCount(0);
    expect(f.errors).toEqual([]);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-background-task.png`,
      fullPage: true,
    });
  } finally {
    hold.release.open();
    await page.goto('about:blank');
    await f.close();
  }
});
