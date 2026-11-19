import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { backgroundFixture } from '../background-fixture.js';
import { buildTools } from '../../src/server/tools.js';

test('Background tasks show one lifecycle, keep chat out, preserve quiet history and locate the chat result', async ({
  page,
}, testInfo) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `tasks-${randomUUID()}@nota.test`,
        name: '后台任务验收',
        password: randomUUID(),
      },
    });
    const userId = (await registration.json()).user.id;
    await f.runtime.ops.submit(userId, randomUUID(), 'tool-history-before-report');
    await f.runtime.processUser(userId);
    const root = await f.runtime.ops.create(userId, randomUUID(), 'trigger', {
      source: 'schedule',
      schedule_title: '查询本周公告',
      text: 'browser-task-lifecycle',
    });
    await page.goto(`${f.base}/#activity`);
    await expect(
      page.getByRole('heading', { name: '交给 Nota，回来查看进展。', exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-task-id]')).toHaveCount(1);
    await expect(page.locator('.operation-list')).not.toContainText('tool-history-before-report');
    await expect(page.getByText('上下文压缩', { exact: true })).toHaveCount(0);
    await page.locator(`[data-task-id="${root.id}"]`).click();
    await expect(page).toHaveURL(`${f.base}/#tasks/${root.id}`);
    await expect(page.getByRole('button', { name: '取消任务', exact: true })).toBeVisible();
    await f.runtime.tasks.process(root.id);
    await expect(page.locator('.task-stage-description')).toHaveText('结果已保存，等待交付');
    await expect(page.locator('[data-task-id]')).toHaveCount(1);
    await expect(page.locator('.task-stages li')).toHaveCount(2);
    await f.runtime.processUser(userId);
    await expect(page.locator('.task-stage-description')).toHaveText('结果已回到对话');
    await expect(page.locator('[data-task-id]')).toHaveCount(0);
    await page.getByRole('button', { name: '查看对话结果', exact: true }).click();
    await expect(page.getByText(/后台任务结果：已核实公告/)).toBeInViewport();
    const quiet = await f.runtime.ops.create(userId, randomUUID(), 'trigger', {
      source: 'schedule',
      schedule_title: '检查公告变化',
      text: '没有变化时只留历史',
      notification_policy: 'on_change',
    });
    const original = f.runtime.tasks.agent.run;
    f.runtime.tasks.agent.run = async (ctx) => {
      await buildTools(ctx)
        .find((tool) => tool.name === 'report_task_outcome')!
        .execute(randomUUID(), {
          summary: '已检查，没有新公告。',
          has_update: false,
          needs_input: false,
        });
      return {
        text: '已检查，没有新公告。',
        usage: 0,
        sessionPath: 'controlled-quiet-task',
        waiting: undefined,
      };
    };
    try {
      await f.runtime.tasks.process(quiet.id);
    } finally {
      f.runtime.tasks.agent.run = original;
    }
    await page.goto(`${f.base}/#tasks`);
    await page.getByRole('button', { name: /^历史记录/ }).click();
    await expect(page.locator('[data-task-id]')).toHaveCount(2);
    await expect(page.locator(`[data-task-id="${quiet.id}"]`)).toContainText('没有新变化');
    await page.locator(`[data-task-id="${quiet.id}"]`).click();
    await expect(page.locator('.task-saved-result')).toContainText('没有新公告');
    await expect(page.locator('.task-detail')).not.toContainText('tokens');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-background-tasks.png`,
      fullPage: true,
    });
    expect(f.errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});

test('Delivery failure opens the original task, retries delivery and does not run research twice', async ({
  page,
}) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `delivery-${randomUUID()}@nota.test`,
        name: '交付重试验收',
        password: randomUUID(),
      },
    });
    const userId = (await registration.json()).user.id;
    const root = await f.runtime.ops.create(userId, randomUUID(), 'trigger', {
      source: 'webhook',
      trigger_name: '外部公告核实',
      text: 'browser-delivery-retry',
    });
    await f.runtime.tasks.process(root.id);
    const original = f.runtime.agent.run;
    f.runtime.agent.run = async () => {
      throw new Error('尚未配置受控交付服务');
    };
    try {
      await f.runtime.processUser(userId);
    } finally {
      f.runtime.agent.run = original;
    }
    await page.goto(`${f.base}/#notifications`);
    await page.locator('.notification-row').click();
    await expect(page).toHaveURL(`${f.base}/#tasks/${root.id}`);
    await expect(page.locator('[data-task-id]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '重试交付', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试交付', exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await f.db.query(
              "SELECT status FROM operations WHERE input->>'background_operation_id'=$1 ORDER BY created_at DESC LIMIT 1",
              [root.id],
            )
          ).rows[0].status,
      )
      .toBe('queued');
    await f.runtime.processUser(userId);
    await expect(page.locator('.task-stage-description')).toHaveText('结果已回到对话');
    const research = (await f.db.query('SELECT attempts FROM operations WHERE id=$1', [root.id]))
      .rows[0];
    expect(research.attempts).toBe(1);
    expect((await f.runtime.ops.usage(userId)).used).toBe(1);
    await page.goto(`${f.base}/#activity/${root.id}`);
    await expect(page).toHaveURL(`${f.base}/#tasks/${root.id}`);
    await expect(page.getByRole('button', { name: '查看对话结果', exact: true })).toBeVisible();
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});

test('Legacy foreground links locate chat retry and history pagination shows only real tasks', async ({
  page,
}) => {
  const f = await backgroundFixture();
  try {
    const registration = await page.request.post(`${f.base}/api/auth/register`, {
      data: {
        email: `task-history-${randomUUID()}@nota.test`,
        name: '任务历史验收',
        password: randomUUID(),
      },
    });
    const userId = (await registration.json()).user.id;
    const chat = await f.runtime.ops.submit(userId, randomUUID(), '旧链接中的即时交办');
    const original = f.runtime.agent.run;
    f.runtime.agent.run = async () => {
      throw new Error('尚未配置受控聊天服务');
    };
    try {
      await f.runtime.processUser(userId);
    } finally {
      f.runtime.agent.run = original;
    }
    await f.db.tx(async (c) => {
      for (let n = 0; n < 65; n++) {
        const id = randomUUID();
        await c.query(
          "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status) VALUES($1,$2,$3,'seed','chat',$4,'succeeded')",
          [
            id,
            userId,
            randomUUID(),
            JSON.stringify({ source: 'web_text', text: `较新的聊天 ${n}` }),
          ],
        );
        for (const role of ['user', 'assistant'])
          await c.query(
            'INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key) VALUES($1,$2,$3,$4,$5,$6)',
            [randomUUID(), userId, id, role, `较新的聊天 ${n}`, `${id}:${role}`],
          );
      }
    });
    await page.goto(`${f.base}/#activity/${chat.id}`);
    await expect(page).toHaveURL(/\/#chat\/[a-f0-9-]+$/);
    await expect(page.getByRole('button', { name: '重试这次交办', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试这次交办', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await f.db.query('SELECT status FROM operations WHERE id=$1', [chat.id])).rows[0].status,
      )
      .toBe('queued');
    const boot = await (await page.request.get(`${f.base}/api/bootstrap`)).json();
    expect(boot.operations.some((op: any) => op.id === chat.id)).toBe(true);
    await f.runtime.processUser(userId);
    await expect(
      page.getByText('前台聊天已回复：旧链接中的即时交办', { exact: true }),
    ).toBeVisible();
    await f.db.tx(async (c) => {
      for (let n = 0; n < 31; n++)
        await c.query(
          "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,executor,status,reply) VALUES($1,$2,$3,'seed','trigger',$4,'background','succeeded','本次检查完成')",
          [
            randomUUID(),
            userId,
            randomUUID(),
            JSON.stringify({
              source: 'schedule',
              schedule_title: `独立查询 ${n}`,
              text: `独立查询 ${n}`,
            }),
          ],
        );
    });
    await page.goto(`${f.base}/#tasks`);
    await expect(page.getByText('没有正在进行或待处理的后台任务', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^历史记录/ }).click();
    await expect(page.locator('[data-task-id]')).toHaveCount(25);
    await page.getByRole('button', { name: '查看更多任务', exact: true }).click();
    await expect(page.locator('[data-task-id]')).toHaveCount(31);
    await expect(page.getByRole('button', { name: '查看更多任务', exact: true })).toHaveCount(0);
    await expect(page.locator('.operation-list')).not.toContainText('旧链接中的即时交办');
  } finally {
    await page.goto('about:blank');
    await f.close();
  }
});
