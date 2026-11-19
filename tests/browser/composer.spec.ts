import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { streamingFixture } from '../streaming-fixture.js';

test('The compact composer grows to a limit, shrinks after editing and keeps the notice in scrolling history', async ({
  page,
}, testInfo) => {
  const fixture = await streamingFixture();
  try {
    const registration = await page.request.post(`${fixture.base}/api/auth/register`, {
      data: {
        email: `composer-${randomUUID()}@nota.test`,
        password: randomUUID(),
        name: '输入体验验收',
      },
    });
    expect(registration.ok()).toBe(true);
    const userId = (await registration.json()).user.id;
    await page.goto(fixture.base);
    const composer = page.locator('.composer'),
      input = page.getByRole('textbox', { name: '发送给 Nota' });
    const height = async () => (await composer.boundingBox())!.height;
    await expect(input).toBeVisible();
    const compact = await height();
    expect(compact).toBeLessThanOrEqual(60);
    await expect(composer.getByRole('button')).toHaveCount(1);
    await expect(composer.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await input.fill('第一行：整理本周的记录。\n第二行：核对日程。\n第三行：保留来源。');
    await expect.poll(height).toBeGreaterThan(compact + 30);
    await input.fill('');
    await expect.poll(height).toBe(compact);

    const viewport = page.viewportSize()!;
    await input.fill('请帮我整理这段稍长的想法，并保留提到的日期、人物和约定。'.repeat(5));
    const wideHeight = await height();
    await page.setViewportSize({ width: 320, height: viewport.height });
    await expect.poll(height).toBeGreaterThan(wideHeight);
    await page.setViewportSize(viewport);
    await expect.poll(height).toBe(wideHeight);
    await input.fill('');

    await fixture.db.query(
      "INSERT INTO messages(id,user_id,role,content,dedupe_key) SELECT gen_random_uuid(),$1,'assistant','对话记录 '||n||'：你的想法、约定和查到的资料都会保留在这里。','composer:'||n FROM generate_series(1,40) n",
      [userId],
    );
    await page.reload();
    await expect(page.locator('.chat-layout.has-conversation')).toBeVisible();
    const pane = page.locator('.chat-scroll'),
      note = pane.locator('.composer-note');
    await expect(note).toBeInViewport();
    await expect(page.locator('.composer-area .composer-note')).toHaveCount(0);
    const noteBox = (await note.boundingBox())!;
    expect(noteBox.y + noteBox.height).toBeLessThan((await composer.boundingBox())!.y);
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-composer-compact.png`,
      fullPage: true,
    });

    await pane.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(note).not.toBeInViewport();
    await expect(composer).toBeInViewport();
    const first = page.locator('[data-message-id]').first();
    const before = (await first.boundingBox())!.y;
    const draft = Array.from(
      { length: 32 },
      (_, i) => `第 ${i + 1} 条：核对资料里的时间与安排，整理完成后保留原文来源。`,
    ).join('\n');
    await input.fill(draft);
    await expect.poll(height).toBeGreaterThan(compact + 100);
    expect(await height()).toBeLessThanOrEqual(252);
    expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    expect(Math.abs((await first.boundingBox())!.y - before)).toBeLessThan(2);
    await expect(note).not.toBeInViewport();
    await pane.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(note).toBeInViewport();
    await input.press('Control+End');
    expect(await input.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-composer-expanded.png`,
      fullPage: true,
    });

    await input.fill('请整理这条想法。');
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('请整理这条想法。\n');
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(compact);
    await expect(composer.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    if (viewport.width <= 650)
      await page.getByRole('button', { name: '打开菜单', exact: true }).click();
    await page.getByRole('button', { name: '记一段声音', exact: false }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: '开始录音', exact: true }),
    ).toBeVisible();
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});
