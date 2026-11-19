import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { streamingFixture } from '../streaming-fixture.js';
import { nativeSteeringFixture } from '../steering-fixture.js';
import { recordingFixture } from '../recording-fixture.js';
import { readFile } from 'node:fs/promises';
import { quotaDay } from '../../src/server/quota.js';
import { wav } from '../helpers.js';

test('Uploads remain available after the Free limit, recover old local copies, and show pending notes without a dropzone', async ({
  page,
}, testInfo) => {
  const fixture = await recordingFixture();
  try {
    await register(page, '额度待处理验收', fixture.base);
    const user = (await (await page.request.get(fixture.base + '/api/me')).json()).user;
    await fixture.db.query('INSERT INTO quota_buckets(user_id,quota_day,used) VALUES($1,$2,10)', [
      user.id,
      quotaDay(),
    ]);
    await page.reload();
    await go(page, '语音便签');
    await expect(page.locator('.upload-dropzone')).toHaveCount(0);
    await expect(page.getByText('放进来一段声音，Nota 来接着做。')).toHaveCount(0);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传录音', exact: true }).click();
    await (
      await chooser
    ).setFiles([
      { name: '额度后便签一.wav', mimeType: 'audio/wav', buffer: wav() },
      { name: '额度后便签二.wav', mimeType: 'audio/wav', buffer: wav() },
    ]);
    await expect(page.locator('.recording-card')).toHaveCount(2);
    await expect(page.locator('.recording-card .status')).toHaveText(['待处理', '待处理']);
    await expect(page.locator('.upload-queue')).toHaveCount(0);
    await page.evaluate(
      async ({ userId, bytes }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('nota-recordings', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('uploads', 'readwrite');
          tx.objectStore('uploads').put({
            id: crypto.randomUUID(),
            userId,
            title: '旧版额度不足录音',
            filename: 'legacy-quota.wav',
            blob: new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
            createdAt: new Date().toISOString(),
            error: '今日 10 次免费额度已用完；北京时间 00:00 重置，可在订阅页查看。',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { userId: user.id, bytes: Array.from(wav()) },
    );
    await page.reload();
    await expect(page.locator('.recording-card')).toHaveCount(3);
    await expect(page.locator('.local-recordings')).toHaveCount(0);
    await expect(page.locator('.upload-queue')).toHaveCount(0);
    await page.getByRole('button', { name: '待处理', exact: true }).click();
    await expect(page.locator('.recording-card')).toHaveCount(3);
    await page.getByRole('button', { name: '已整理', exact: true }).click();
    await expect(page.locator('.recording-card')).toHaveCount(0);
    await page.getByRole('button', { name: '待处理', exact: true }).click();
    await expect(page.locator('.recording-card')).toHaveCount(3);
    await expect(page.getByTestId('recording-window')).toHaveCount(0);
    expect(fixture.requests).toHaveLength(0);
    const usage = await (await page.request.get(fixture.base + '/api/usage')).json();
    expect(usage.used).toBe(10);
    expect(usage.reserved).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-recordings-quota-pending.png`,
      fullPage: true,
    });
    await page.locator('.recording-card').filter({ hasText: '旧版额度不足录音' }).click();
    await expect(page.locator('.recording-detail').getByRole('status')).toContainText(
      '录音已上传，免费额度已用完',
    );
    await expect(page.getByRole('button', { name: '修订原文' })).toBeDisabled();
    const recording = (
      await (await page.request.get(fixture.base + '/api/recordings')).json()
    ).recordings.find((r: any) => r.title === '旧版额度不足录音');
    expect(
      (await page.request.get(fixture.base + `/api/recordings/${recording.id}/audio`)).ok(),
    ).toBe(true);
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});

test('Dynamic recording backlog coalesces 1 plus 5, leaves chat responsive, and delivers one sourced native Agent result', async ({
  page,
}, testInfo) => {
  const fixture = await recordingFixture();
  try {
    await register(page, '录音窗口验收', fixture.base);
    const buffer = await readFile('tests/fixtures/nota-chinese.wav');
    const upload = async (n: number) => {
      const response = await page.request.post(fixture.base + '/api/recordings', {
        multipart: {
          idempotency_key: randomUUID(),
          title: `窗口录音 ${n}`,
          instruction:
            n === 1
              ? '请整理并执行明确交办。'
              : '仅摘要，不提取人物记忆，不创建任何待办日程或提醒。',
          recorded_at: new Date().toISOString(),
          recorded_timezone: 'Asia/Shanghai',
          file: { name: `memo-${n}.wav`, mimeType: 'audio/wav', buffer },
        },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const first = await upload(1);
    await fixture.started.wait;
    await expect(page.getByTestId('recording-window')).toHaveCount(0);
    await expect(page.locator('.chat-heading')).toBeVisible();
    await expect(page.locator('.execution-process')).toHaveCount(0);
    expect(
      (await (await page.request.get(fixture.base + '/api/bootstrap')).json()).operations,
    ).toHaveLength(0);
    expect(fixture.requests).toHaveLength(0);
    await go(page, '语音便签');
    await expect(page.getByTestId('recording-window')).toContainText('正在整理 1 条声音');
    await go(page, '与 Nota 对话');
    await page.getByRole('textbox', { name: '发送给 Nota' }).fill('录音处理中，我能继续聊天吗？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      page.getByText('可以，录音在独立整理，我现在就能回应你的聊天。', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.chat-heading')).toHaveCount(0);
    await expect(page.locator('.suggestions')).toHaveCount(0);
    await expect(page.locator('.chat-aside')).toHaveCount(0);
    await expect(page.locator('.execution-process')).toHaveCount(0);
    await expect(page.getByRole('separator', { name: '新消息分界线' })).toHaveCount(0);
    const rest = [];
    for (let n = 2; n <= 6; n++) rest.push(await upload(n));
    expect(rest.every((r) => r.batch_id === first.batch_id)).toBe(true);
    await expect(page.getByTestId('recording-window')).toHaveCount(0);
    await go(page, '语音便签');
    await expect(page.getByTestId('recording-window')).toContainText('正在整理 6 条声音');
    await page.reload();
    await expect(page.getByTestId('recording-window')).toContainText('正在整理 6 条声音');
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-recording-window-running.png`,
      fullPage: true,
    });
    await go(page, '与 Nota 对话');
    await fixture.flush();
    await expect(
      page.getByText('这 6 条便签已统一整理，已创建一项核对附件的待办。', { exact: false }),
    ).toBeVisible();
    await expect(page.getByTestId('recording-window')).toHaveCount(0);
    expect(
      (await fixture.db.query("SELECT * FROM messages WHERE kind='trigger' AND role='assistant'"))
        .rows,
    ).toHaveLength(1);
    expect((await fixture.db.query('SELECT * FROM agent_inbox')).rows).toHaveLength(1);
    expect((await fixture.db.query('SELECT * FROM todos')).rows).toHaveLength(1);
    const usage = await (await page.request.get(fixture.base + '/api/usage')).json();
    expect(usage.used).toBe(7);
    expect(usage.reserved).toBe(0);
    const botRequests = fixture.requests.filter((r) =>
      r.messages.some((m: any) => JSON.stringify(m.content).includes('recording_batch')),
    );
    expect(botRequests.length).toBeGreaterThan(0);
    expect(
      botRequests.every((r) => !JSON.stringify(r).includes('唯一原文标记-RAW-ONLY-938427')),
    ).toBe(true);
    expect(fixture.errors).toHaveLength(0);
    await page.getByRole('link', { name: '查看原文出处' }).click();
    await expect(page.getByText('引用位置及附近原文 · 版本 1', { exact: true })).toBeVisible();
    await expect(page.locator('.source-excerpt .is-cited')).toContainText('青禾项目报价8.6万元');
    await page.getByRole('button', { name: '查看该版本全文' }).click();
    await expect(page.locator('.transcript-plain')).toContainText('唯一原文标记-RAW-ONLY-938427');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-recording-source.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});
test('A quiet empty composer becomes only the conversation; short history and plain replies have no empty controls', async ({
  page,
}, testInfo) => {
  const fixture = await streamingFixture();
  try {
    await register(page, '轻量对话验收', fixture.base);
    await expect(page.locator('.chat-layout.is-empty')).toBeVisible();
    await expect(page.locator('.chat-heading')).toBeVisible();
    await expect(page.locator('.chat-aside')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看更早的对话', exact: true })).toHaveCount(0);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-quiet-empty.png`,
      fullPage: true,
    });
    const u = (await (await page.request.get(fixture.base + '/api/me')).json()).user.id;
    const op = randomUUID(),
      id = randomUUID();
    await fixture.db.tx(async (c) => {
      await c.query(
        "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status) VALUES($1,$2,$3,'fixture','trigger','{}','succeeded')",
        [op, u, op],
      );
      await c.query(
        "INSERT INTO messages(id,user_id,operation_id,role,kind,content,dedupe_key,process) VALUES($1,$2,$3,'assistant','trigger','便签已经整理好了。',$4,$5)",
        [
          id,
          u,
          op,
          `${op}:response`,
          JSON.stringify({
            stats_version: 2,
            cycle: 0,
            tools: 0,
            tools_known: true,
            duration_ms: 2000,
            status: 'succeeded',
            notes: 0,
          }),
        ],
      );
    });
    await page.reload();
    await expect(page.getByText('便签已经整理好了。', { exact: true })).toBeVisible();
    await expect(page.locator('.chat-heading')).toHaveCount(0);
    await expect(page.locator('.suggestions')).toHaveCount(0);
    await expect(page.locator('.execution-process')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看更早的对话', exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(fixture.base + '/api/bootstrap')).json()).read_state
            .last_read_message_id,
      )
      .toBe(id);
    await page.reload();
    await expect(page.locator('.unread-banner')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-quiet-reply.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});

test('Unread progress survives navigation and reload, requires its actual boundary, and synchronizes across tabs', async ({
  page,
  context,
}, testInfo) => {
  const fixture = await streamingFixture();
  let cover: Page | undefined;
  let releaseRead: (() => void) | undefined;
  try {
    await register(page, '未读进度验收', fixture.base);
    const u = (await (await page.request.get(fixture.base + '/api/me')).json()).user.id;
    await go(page, '人物与记忆');
    const ids: string[] = [];
    await fixture.db.tx(async (c) => {
      for (let n = 1; n <= 160; n++) {
        const id = randomUUID();
        ids.push(id);
        await c.query(
          "INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,'assistant','trigger',$3,$4)",
          [id, u, `后台结果 ${n}：请复核这条便签中的约定。`, `unread:${n}`],
        );
      }
    });
    const state = async () =>
      (await (await page.request.get(fixture.base + '/api/bootstrap')).json()).read_state;
    await page.reload();
    expect((await state()).unread_count).toBe(160);
    expect((await state()).last_read_seq).toBe('0');
    await go(page, '与 Nota 对话');
    await expect(page.locator('.unread-banner')).toContainText('160 条未读消息');
    await expect(page.locator(`[data-message-id="${ids[0]}"]`)).toHaveCount(0);
    await page.waitForTimeout(850); // Longer than the visible-message acknowledgement dwell.
    expect((await state()).last_read_seq).toBe('0');
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-unread-banner.png`,
      fullPage: true,
    });
    const acknowledgement = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    await page.route(
      '**/api/chat/read',
      async (route) => {
        await acknowledgement;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: '跳转到未读', exact: true }).click();
    await expect(page.locator(`[data-message-id="${ids[0]}"]`)).toBeInViewport();
    await expect(page.getByRole('separator', { name: '新消息分界线' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '查看更早的对话', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看后续对话', exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-unread-divider.png`,
      fullPage: true,
    });
    releaseRead?.();
    await expect.poll(async () => (await state()).unread_count).toBe(0);
    expect((await state()).last_read_message_id).toBe(ids.at(-1));
    await expect(page.getByRole('separator', { name: '新消息分界线' })).toHaveCount(0);
    cover = await context.newPage();
    await cover.goto(fixture.base + '/#memory');
    await cover.bringToFront();
    const fresh = randomUUID();
    await fixture.db.query(
      "INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,'assistant','reminder','新的到点提醒，只有看到后才清除未读。','hidden-reminder')",
      [fresh, u],
    );
    // Headless Chromium keeps every tab visible. Exercise the real visibility event with a controlled lifecycle state.
    await page.addInitScript(() => {
      (window as any).__notaTestHidden = true;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => ((window as any).__notaTestHidden ? 'hidden' : 'visible'),
      });
    });
    await page.reload();
    await expect(
      page.getByText('新的到点提醒，只有看到后才清除未读。', { exact: true }),
    ).toBeAttached();
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    await page.waitForTimeout(850);
    expect((await state()).unread_count).toBe(1);
    await cover.reload();
    await expect(cover.locator('.main-nav').getByLabel('未读对话')).toHaveText('1');
    await page.bringToFront();
    await page.evaluate(() => {
      (window as any).__notaTestHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await state()).last_read_message_id).toBe(fresh);
    await expect(cover.locator('.main-nav').getByLabel('未读对话')).toHaveCount(0);
    await page.locator('.chat-scroll').evaluate((node) => {
      node.scrollTop = 0;
    });
    const offscreen = randomUUID();
    await fixture.db.tx(async (c) => {
      await c.query(
        "INSERT INTO messages(id,user_id,role,kind,content,dedupe_key) VALUES($1,$2,'assistant','trigger','视口外的新结果，滚到这里再读。','offscreen-result')",
        [offscreen, u],
      );
      await c.query("INSERT INTO user_events(user_id,type,data) VALUES($1,'changed','{}')", [u]);
    });
    await expect(page.locator('.unread-banner')).toContainText('1 条未读消息');
    await expect(page.locator(`[data-message-id="${offscreen}"]`)).toBeAttached();
    await expect(page.locator(`[data-message-id="${offscreen}"]`)).not.toBeInViewport();
    await page.waitForTimeout(850);
    expect((await state()).last_read_message_id).toBe(fresh);
    await page.locator(`[data-message-id="${offscreen}"]`).scrollIntoViewIfNeeded();
    await expect.poll(async () => (await state()).last_read_message_id).toBe(offscreen);
    await page.reload();
    await expect(page.locator('.unread-banner')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  } finally {
    releaseRead?.();
    await cover?.close();
    await page.goto('about:blank');
    await fixture.close();
  }
});
async function register(page: Page, name = '浏览器验收', url = '/') {
  await page.goto(url);
  await page.getByRole('button', { name: '第一次来？创建账号' }).click();
  const email = `browser-${randomUUID()}@nota.local`,
    password = randomUUID();
  await page.getByLabel('怎么称呼你').fill(name);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '发送给 Nota' })).toBeVisible();
  return { email, password };
}
async function go(page: Page, label: string) {
  if ((page.viewportSize()?.width ?? 1000) <= 650)
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.locator('.main-nav').getByRole('button', { name: label, exact: false }).click();
}
async function openRecorder(page: Page) {
  if ((page.viewportSize()?.width ?? 1000) <= 650)
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.getByRole('button', { name: '记一段声音', exact: false }).click();
}
test('Collapsed legacy processes show restored tool counts and active time without counting the clarification wait', async ({
  page,
}, testInfo) => {
  const fixture = await streamingFixture();
  try {
    await register(page, '历史统计验收', fixture.base);
    const me = await (await page.request.get(fixture.base + '/api/me')).json(),
      u = me.user.id;
    const first = randomUUID(),
      second = randomUUID(),
      base = Date.parse('2026-11-12T15:00:00Z');
    const date = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    await fixture.db.tx(async (c) => {
      const emit = async (id: string, type: string, data: any, seconds: number) =>
        (
          await c.query(
            'INSERT INTO user_events(user_id,operation_id,type,data,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id::text',
            [u, id, type, JSON.stringify(data), date(seconds)],
          )
        ).rows[0].id;
      for (const [id, status] of [
        [first, 'succeeded'],
        [second, 'cancelled'],
      ])
        await c.query(
          "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status) VALUES($1,$2,$4,'fixture','chat','{}',$3)",
          [id, u, status, id],
        );
      await emit(first, 'operation', { status: 'queued' }, 0);
      await emit(first, 'operation', { status: 'running' }, 50);
      await emit(
        first,
        'tool',
        { id: randomUUID(), name: 'create_reminder', label: '设置提醒', status: 'succeeded' },
        52,
      );
      await emit(first, 'operation', { status: 'succeeded' }, 53);
      await c.query(
        "INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,created_at) VALUES($1,$2,$3,'assistant','旧版提醒已设置',$4,$5)",
        [randomUUID(), u, first, `${first}:response:0`, date(53)],
      );
      const from = await emit(second, 'operation', { status: 'queued' }, 60);
      await emit(second, 'operation', { status: 'running' }, 61);
      await emit(
        second,
        'tool',
        { id: randomUUID(), name: 'ask_user', label: '等待补充信息', status: 'succeeded' },
        64,
      );
      const to = await emit(second, 'operation', { status: 'waiting' }, 113);
      await emit(second, 'operation', { status: 'cancelled', cycle: 0 }, 1660);
      await c.query(
        "INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,created_at,process) VALUES($1,$2,$3,'assistant','旧版任务已停止',$4,$5,$6)",
        [
          randomUUID(),
          u,
          second,
          `${second}:cancelled:0`,
          date(1660),
          JSON.stringify({
            cycle: 0,
            from_event: from,
            to_event: to,
            started_at: date(60),
            finished_at: date(1660),
            status: 'cancelled',
            tools: 1,
            notes: 0,
          }),
        ],
      );
    });
    await page.reload();
    const one = page.locator(`.execution-process[data-operation-id="${first}"]`),
      two = page.locator(`.execution-process[data-operation-id="${second}"]`);
    await expect(one.getByRole('button', { name: '展开执行过程' })).toContainText(
      '用时 3 秒 · 1 个工具步骤',
    );
    await expect(two.getByRole('button', { name: '展开执行过程' })).toContainText(
      '用时 52 秒 · 1 个工具步骤',
    );
    await expect(one.locator('.process-body')).toHaveCount(0);
    await expect(two.locator('.process-body')).toHaveCount(0);
    await expect(page.getByLabel('后续消息处理方式')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-process-statistics.png`,
      fullPage: true,
    });
    await one.getByRole('button', { name: '展开执行过程' }).click();
    await expect(one.locator('.process-tool')).toHaveCount(1);
    await expect(one).toContainText('设置提醒');
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});
const date = (offset: number) => {
  const d = new Date(Date.now() + offset * 864e5);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
};
test('Real manual management, subscription lifecycle and responsive navigation', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const identity = await register(page);
  await go(page, '日程与待办');
  await page.getByRole('button', { name: /^待办事项/ }).click();
  await page.getByRole('button', { name: '新建待办', exact: true }).click();
  let modal = page.getByRole('dialog');
  const title = `浏览器待办-${testInfo.project.name}`;
  await modal.getByLabel('标题', { exact: true }).fill(title);
  await modal.getByLabel('指定截止时刻', { exact: true }).check();
  await modal.getByLabel(/截止日期（可选）/).fill(`${date(2)}T10:00`);
  await modal.getByLabel('备注', { exact: true }).fill('通过真实接口保存，手动管理不扣 AI 额度');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('.todo-row').filter({ hasText: title })).toBeVisible();
  await page.getByRole('button', { name: `完成待办 ${title}`, exact: true }).click();
  await expect(page.locator('.todo-row').filter({ hasText: title })).toHaveClass(/done/);
  await page.getByRole('button', { name: '日历', exact: true }).click();
  await page.getByRole('button', { name: '新建事项', exact: true }).click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('标题', { exact: true }).fill('浏览器评审');
  await modal.getByLabel('全天 / 仅日期', { exact: true }).uncheck();
  await modal.getByLabel('开始时间', { exact: true }).fill(`${date(2)}T15:00`);
  await modal.getByLabel('结束时间（可选）', { exact: true }).fill(`${date(2)}T16:00`);
  await modal.getByLabel('地点（可选）').fill('线上');
  await modal.getByRole('button', { name: '保存', exact: true }).click();
  await expect(modal).toBeHidden();
  const usage = await (await page.request.get('/api/usage')).json();
  expect(usage.used).toBe(0);
  expect(usage.reserved).toBe(0);
  await go(page, '人物与记忆');
  await expect(page.getByRole('heading', { name: '记得细节，也记得来处。' })).toBeVisible();
  await expect(page.getByText('记忆从你的便签里长出来。')).toBeVisible();
  await expect(page.getByRole('button', { name: '登记我的声音' })).toHaveCount(0);
  await go(page, '后台任务');
  await expect(page.getByRole('heading', { name: '交给 Nota，回来查看进展。' })).toBeVisible();
  await expect(page.getByText('没有正在进行或待处理的后台任务')).toBeVisible();
  if ((page.viewportSize()?.width ?? 1000) <= 650)
    await page.locator('.mobile-nav').getByRole('button', { name: '我的', exact: true }).click();
  else await page.getByRole('button', { name: '账户设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的 Nota，你的方式。' })).toBeVisible();
  await expect(page.getByRole('button', { name: /我的声音|声纹|参考声音/ })).toHaveCount(0);
  await expect(page.locator('.settings-page .page-tabs button')).toHaveText([
    '个人与服务',
    '外部触发',
    '上下文与历史',
  ]);
  if ((page.viewportSize()?.width ?? 1000) <= 650)
    await page.getByRole('button', { name: '打开菜单' }).click();
  await page.locator('.quota-widget').click();
  await expect(page.getByText('当前为演示订阅，不会产生任何扣款。')).toBeVisible();
  await page.getByRole('button', { name: '体验 Pro（演示）', exact: true }).click();
  await expect(
    page.locator('.plan-card.pro').getByRole('button', { name: '当前计划', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '取消续订', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('已取消续订，本周期到期后恢复 Free。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `test-results/e2e-${testInfo.project.name}-billing.png`,
    fullPage: true,
  });
});
test('MediaRecorder works offline, survives reload, and retries a lost acknowledgement exactly once', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['microphone']);
  await register(page, '离线录音验收');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await expect(page.getByText(/当前离线。你仍可录音/)).toBeVisible();
  await openRecorder(page);
  let modal = page.getByRole('dialog');
  await expect(modal.getByText(/区分说话人|声纹|参考声音/)).toHaveCount(0);
  const title = `离线声音-${testInfo.project.name}`;
  await modal.getByLabel('便签标题', { exact: true }).fill(title);
  await modal.getByRole('button', { name: '开始录音', exact: true }).click();
  await expect(modal.getByText('正在录音', { exact: true })).toBeVisible();
  await page.waitForTimeout(3200);
  await modal.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(modal.getByText('录音已暂停', { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await modal.getByRole('button', { name: '继续', exact: true }).click();
  await page.waitForTimeout(1000);
  await modal.getByRole('button', { name: '结束并整理', exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('.upload-queue')).toHaveCount(0);
  await go(page, '语音便签');
  await expect(page.locator('.upload-queue')).toContainText('1 段录音等待上传');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.upload-queue')).toContainText('1 段录音等待上传');
  await expect(page.locator('.local-recordings')).toContainText(title);
  let postCount = 0;
  await page.route('**/api/recordings', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    postCount++;
    if (postCount === 1) {
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await context.setOffline(false);
  await expect.poll(() => postCount, { timeout: 20000 }).toBe(1);
  await expect(page.locator('.upload-queue')).toBeVisible();
  await page
    .locator('.upload-queue')
    .getByRole('button', { name: '重试上传', exact: true })
    .click();
  await expect(page.locator('.upload-queue')).toBeHidden({ timeout: 30000 });
  expect(postCount).toBe(2);
  const data = await (
    await page.request.get(`/api/recordings?q=${encodeURIComponent(title)}`)
  ).json();
  expect(data.recordings).toHaveLength(1);
  expect(Number(data.recordings[0].duration_seconds)).toBeGreaterThan(3.5);
  const usage = await (await page.request.get('/api/usage')).json();
  expect(usage.used + usage.reserved).toBe(1);
  await go(page, '语音便签');
  await expect(page.getByRole('heading', { name: '每条便签，都有下文。' })).toBeVisible();
  await expect(page.getByText(/上传时区分说话人/)).toHaveCount(0);
  await page.getByRole('button').filter({ hasText: title }).last().click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(
    (
      await page.request.get(`/api/recordings/${data.recordings[0].id}/audio`, {
        headers: { range: 'bytes=0-15' },
      })
    ).status(),
  ).toBe(206);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({
    path: `test-results/e2e-${testInfo.project.name}-recording.png`,
    fullPage: true,
  });
});
test('A denied microphone returns an actionable state', async ({ page }) => {
  await register(page, '权限验收');
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await openRecorder(page);
  await page.getByRole('dialog').getByRole('button', { name: '开始录音', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('麦克风权限未开启');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: '开始录音', exact: true }),
  ).toBeEnabled();
});

test('Streamed text and folded tools form one process that collapses on completion and restores after reload', async ({
  page,
}, testInfo) => {
  const fixture = await streamingFixture();
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await register(page, '过程体验验收（受控模型）', fixture.base);
    await page.getByRole('textbox', { name: '发送给 Nota' }).fill('请保存一条待办，再检查日程。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const process = page.locator('.execution-process').last();
    await expect(process).toHaveClass(/is-live/);
    await expect(process.getByRole('button', { name: '收起执行过程', exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      (window as any).__notaTypingLengths = [];
      const observer = new MutationObserver(() => {
        const length = document.querySelector('.process-text .markdown')?.textContent?.length ?? 0;
        (window as any).__notaTypingLengths.push(length);
      });
      observer.observe(document.querySelector('.execution-process')!, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    fixture.gates.start.open();
    const first = process.locator('.process-text .markdown').first();
    await expect
      .poll(async () => ((await first.textContent()) ?? '').length, {
        intervals: [50, 50, 50, 100],
      })
      .toBeGreaterThan(0);
    await expect(first).toHaveText(fixture.firstText);
    const samples: number[] = await page.evaluate(() => (window as any).__notaTypingLengths);
    expect(samples.some((length) => length > 0 && length < fixture.firstText.length)).toBe(true);
    fixture.gates.first.open();
    await expect(process.locator('.process-tool')).toHaveCount(1);
    await expect(process.getByRole('button', { name: '收起执行过程', exact: true })).toBeVisible();
    await expect(process.locator('.process-tool').first().locator('.trace-detail')).toBeHidden();
    fixture.gates.tool.open();
    await expect(process.getByText(fixture.middleText, { exact: true })).toBeVisible();
    await expect(process.locator('.process-tool')).toHaveCount(2);
    await expect(first).toHaveText(fixture.firstText);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-process-running.png`,
      fullPage: true,
    });
    fixture.gates.second.open();
    await expect(process.getByText(fixture.finalText, { exact: true })).toBeVisible();
    expect(
      await page.locator('.message-content').filter({ hasText: fixture.finalText }).count(),
    ).toBe(0);
    fixture.gates.final.open();
    await expect(page.locator('.execution-process.is-live')).toHaveCount(0);
    await expect(page.getByText(fixture.finalText, { exact: true })).toBeVisible();
    await expect(process.getByRole('button', { name: '展开执行过程', exact: true })).toBeVisible();
    await expect(process.locator('.process-body')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-process-completed.png`,
      fullPage: true,
    });
    await process.getByRole('button', { name: '展开执行过程', exact: true }).click();
    await expect(process.getByText(fixture.firstText, { exact: true })).toBeVisible();
    await expect(process.getByText(fixture.middleText, { exact: true })).toBeVisible();
    await expect(process.locator('.process-tool')).toHaveCount(2);
    await expect(page.getByText(fixture.finalText, { exact: true })).toHaveCount(1);
    await expect(process.locator('.trace-detail').first()).toBeHidden();
    await process.locator('.process-tool summary').first().click();
    await expect(process.locator('.trace-detail').first()).toBeVisible();
    await expect(process.locator('.trace-detail').first()).toContainText('核对便签交办的事项');
    await page.reload();
    await expect(page.getByText(fixture.finalText, { exact: true })).toBeVisible();
    await expect(process.locator('.process-body')).toHaveCount(0);
    await process.getByRole('button', { name: '展开执行过程', exact: true }).click();
    await expect(process.getByText(fixture.firstText, { exact: true })).toBeVisible();
    await expect(process.getByText(fixture.middleText, { exact: true })).toBeVisible();
    await expect(process.locator('.trace-detail').first()).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-process-expanded.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});

test('Follow-ups always steer; no selector or legacy saved queue preference can change the mode', async ({
  page,
}, testInfo) => {
  const fixture = await nativeSteeringFixture();
  try {
    await register(page, '引导体验验收', fixture.base);
    await page.evaluate(async () => {
      const me = await (await fetch('/api/me')).json();
      localStorage.setItem(`nota:send-mode:${me.user.id}`, 'queue');
    });
    await page.reload();
    await expect(page.getByLabel('后续消息处理方式')).toHaveCount(0);
    const send = async (text: string) => {
      await page.getByRole('textbox', { name: '发送给 Nota' }).fill(text);
      await page.getByRole('button', { name: '发送', exact: true }).click();
    };
    await send('设置后天上午3点叫我起床');
    await fixture.first.wait;
    const operation = (await (await page.request.get(fixture.base + '/api/operations')).json())
      .operations[0];
    await expect(page.locator('.execution-process.is-live')).toHaveCount(1);
    await send('不，上午6点吧');
    await expect(page.getByText('补充已收到，将在当前步骤后接入', { exact: true })).toBeVisible();
    expect(
      (await (await page.request.get(fixture.base + '/api/operations')).json()).operations,
    ).toHaveLength(1);
    fixture.releaseFirst.open();
    await fixture.afterCreate.wait;
    await expect(page.locator('.input-preview').filter({ hasText: '补充已收到' })).toHaveCount(0);
    const reminder = (await fixture.db.query('SELECT id,remind_at FROM reminders')).rows;
    expect(reminder).toHaveLength(1);
    expect(new Date(reminder[0].remind_at).toISOString()).toBe(
      new Date(fixture.at(6)).toISOString(),
    );
    const originalId = reminder[0].id;
    const queuedRequest = await page.request.post(fixture.base + '/api/chat', {
      data: { text: '内部排队兼容验证', mode: 'queue', idempotency_key: randomUUID() },
    });
    expect(queuedRequest.ok()).toBe(true);
    await expect(page.locator('.queued-preview')).toContainText('1 项交办排队中');
    await expect(page.locator('.execution-process.is-live')).toHaveCount(1);
    const queued = (
      await (await page.request.get(fixture.base + '/api/operations')).json()
    ).operations.find((o: any) => o.id !== operation.id);
    const cancelled = await page.request.post(
      `${fixture.base}/api/operations/${queued.id}/cancel`,
      { data: {} },
    );
    expect(cancelled.ok()).toBe(true);
    await expect(page.locator('.queued-preview')).toHaveCount(0);
    await page.evaluate(async (id) => {
      const me = await (await fetch('/api/me')).json();
      sessionStorage.setItem(`nota:reply:${me.user.id}`, id);
      localStorage.setItem(`nota:send-mode:${me.user.id}`, 'queue');
    }, queued.id);
    await page.reload();
    await expect(page.getByLabel('后续消息处理方式')).toHaveCount(0);
    await send('改成上午7点吧');
    await expect(page.getByText('补充已收到，将在当前步骤后接入', { exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-steering-running.png`,
      fullPage: true,
    });
    fixture.releaseAfterCreate.open();
    const final = `已将同一条提醒改为 ${fixture.day} 上午7点，原来的6点创建记录保留。`;
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    await expect(page.locator('.execution-process.is-live')).toHaveCount(0);
    await expect(page.getByText('有一个任务在等你补充', { exact: true })).toHaveCount(0);
    const updated = (await fixture.db.query('SELECT id,remind_at FROM reminders')).rows;
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(originalId);
    expect(new Date(updated[0].remind_at).toISOString()).toBe(
      new Date(fixture.at(7)).toISOString(),
    );
    const usage = await (await page.request.get(fixture.base + '/api/usage')).json();
    expect(usage.used).toBe(1);
    expect(usage.reserved).toBe(0);
    await page.reload();
    await expect(page.getByText(final, { exact: true })).toBeVisible();
    await expect(page.getByLabel('后续消息处理方式')).toHaveCount(0);
    const process = page.locator(`.execution-process[data-operation-id="${operation.id}"]`);
    await process.getByRole('button', { name: '展开执行过程', exact: true }).click();
    await expect(process.getByText('已跳过', { exact: true })).toBeVisible();
    await expect(process.locator('.process-input')).toHaveCount(2);
    await expect(process).toContainText('6点的提醒已经存在');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-steering-completed.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});
