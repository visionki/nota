import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { streamingFixture } from '../streaming-fixture.js';
// Route the delayed image through the test driver, rather than a cached service worker.
test.use({ serviceWorkers: 'block' });

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
async function visiblePosition(page: Page, id?: string) {
  return page.locator('.chat-scroll').evaluate((pane, selected) => {
    const top = pane.getBoundingClientRect().top;
    const nodes = Array.from(pane.querySelectorAll<HTMLElement>('[data-message-id]'));
    const node = selected
      ? nodes.find((n) => n.dataset.messageId === selected)
      : nodes.find((n) => n.getBoundingClientRect().bottom > top + 8);
    if (!node) throw new Error('Visible message was not found');
    return { id: node.dataset.messageId!, offset: node.getBoundingClientRect().top - top };
  }, id);
}
for (const scenario of [
  'scroll-during-request',
  'new-message-during-request',
  'late-image-above-reader',
] as const) {
  test(`Loading history preserves the visible message position: ${scenario}`, async ({
    page,
  }, testInfo) => {
    const fixture = await streamingFixture(),
      delayed = gate(),
      started = gate(),
      image = gate();
    let imageRequested = false;
    try {
      await page.goto(fixture.base);
      await page.getByRole('button', { name: '第一次来？创建账号' }).click();
      await page.getByLabel('怎么称呼你').fill('历史滚动验收');
      await page.getByLabel('邮箱', { exact: true }).fill(`${randomUUID()}@nota.test`);
      await page.getByLabel('密码', { exact: true }).fill(randomUUID());
      await page.getByRole('button', { name: '创建账号', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '发送给 Nota' })).toBeVisible();
      const u = (await (await page.request.get(fixture.base + '/api/me')).json()).user.id;
      await fixture.db.tx(async (c) => {
        for (let n = 1; n <= 180; n++)
          await c.query(
            "INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,'user',$3,$4)",
            [
              randomUUID(),
              u,
              n === 70 && scenario === 'late-image-above-reader'
                ? '历史插图\n\n![延后加载的插图](/favicon.svg?history-anchor-image)'
                : `历史便签 ${n}：继续保留正在阅读的这条消息与位置。`,
              `history:${n}`,
            ],
          );
      });
      await page.route('**/favicon.svg?history-anchor-image', async (route) => {
        imageRequested = true;
        await image.wait;
        await route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="360"><rect width="280" height="360" fill="#e7eee1"/></svg>',
        });
      });
      await page.reload();
      await expect(page.locator('[data-message-id]')).toHaveCount(100);
      await page.locator('.chat-scroll').evaluate((pane) => {
        pane.scrollTop = 0;
      });
      await expect(
        page.getByRole('button', { name: '查看更早的对话', exact: true }),
      ).toBeInViewport();
      await page.route(
        '**/api/messages?before=*',
        async (route) => {
          const response = await route.fetch();
          started.open();
          await delayed.wait;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      await page.getByRole('button', { name: '查看更早的对话', exact: true }).click();
      await started.wait;
      if (scenario === 'scroll-during-request') {
        await page.locator('.chat-scroll').evaluate((pane) => {
          pane.scrollTop = 420;
        });
      } else if (scenario === 'new-message-during-request') {
        await fixture.db.tx(async (c) => {
          await c.query(
            "INSERT INTO messages(id,user_id,role,content,dedupe_key) VALUES($1,$2,'user',$3,'new-tail')",
            [randomUUID(), u, '加载历史时收到的新内容。\n\n'.repeat(35)],
          );
          await c.query("INSERT INTO user_events(user_id,type,data) VALUES($1,'changed','{}')", [
            u,
          ]);
        });
        await expect(page.locator('[data-message-id]')).toHaveCount(101);
      }
      const anchor = await visiblePosition(page);
      delayed.open();
      await expect(page.locator('[data-message-id]')).toHaveCount(
        scenario === 'new-message-during-request' ? 151 : 150,
      );
      if (scenario === 'late-image-above-reader') {
        await expect.poll(() => imageRequested).toBe(true);
        await expect
          .poll(async () =>
            Math.abs((await visiblePosition(page, anchor.id)).offset - anchor.offset),
          )
          .toBeLessThan(2);
        image.open();
        await expect(page.getByRole('img', { name: '延后加载的插图' })).toHaveJSProperty(
          'naturalHeight',
          360,
        );
      }
      await expect
        .poll(async () => Math.abs((await visiblePosition(page, anchor.id)).offset - anchor.offset))
        .toBeLessThan(2);
      const finalPosition = await visiblePosition(page, anchor.id);
      await testInfo.attach('reading-position', {
        contentType: 'application/json',
        body: JSON.stringify({
          scenario,
          before: anchor.offset,
          after: finalPosition.offset,
          difference: finalPosition.offset - anchor.offset,
        }),
      });
      await page.screenshot({
        path: `test-results/e2e-${testInfo.project.name}-history-${scenario}.png`,
        fullPage: true,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    } finally {
      delayed.open();
      image.open();
      await page.goto('about:blank');
      await fixture.close();
    }
  });
}
