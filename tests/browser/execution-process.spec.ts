import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { streamingFixture } from '../streaming-fixture.js';
import { emit } from '../../src/server/db.js';
import { readExecutionProcess } from '../../src/server/execution.js';
import { summarizeProcess } from '../../src/shared/execution.js';

test('External search and page-reading records recover from proxy failures and restore after reload', async ({
  page,
}, testInfo) => {
  const fixture = await streamingFixture();
  try {
    const registration = await page.request.post(`${fixture.base}/api/auth/register`, {
      data: {
        email: `web-process-${randomUUID()}@nota.test`,
        name: '检索过程验收',
        password: randomUUID(),
      },
    });
    expect(registration.ok()).toBe(true);
    const userId = (await registration.json()).user.id,
      operationId = randomUUID();
    const finalText = '已查询公开资料，并阅读官方网页，来源已附在答复中。';
    await fixture.db.tx(async (c) => {
      await c.query(
        "INSERT INTO operations(id,user_id,idempotency_key,payload_hash,kind,input,status,reply) VALUES($1,$2,$4,'fixture','chat','{}','succeeded',$3)",
        [operationId, userId, finalText, operationId],
      );
      const event = (type: string, data: object) =>
        emit(c, userId, type, { ...data, cycle: 0 }, operationId);
      await event('operation', { status: 'running' });
      const firstTurn = randomUUID();
      await event('text_reset', { turn_id: firstTurn });
      await event('text', { turn_id: firstTurn, delta: '我先检索公开信息，再阅读网页核实来源。' });
      await event('text_end', { turn_id: firstTurn });
      for (const [index, name] of ['search_web', 'read_webpage', 'search_web'].entries()) {
        const id = randomUUID(),
          label = name === 'search_web' ? '搜索网页' : '读取网页正文';
        const input =
          name === 'search_web'
            ? { query: '深圳公开会议时间', limit: 5 }
            : { url: 'https://example.com/official' };
        await event('tool', { id, name, label, input, status: 'running' });
        const result =
          name === 'search_web'
            ? {
                provider: 'tavily',
                external_content: true,
                results: Array.from({ length: 5 }, (_, n) => ({
                  title: `官方资料 ${index}-${n}`,
                  url: `https://example.com/official?source=${n}`,
                  snippet: '公开网页中的相关资料，含中文和换行。\n'.repeat(80),
                })),
              }
            : {
                provider: 'tavily',
                url: 'https://example.com/official',
                content: '# 官方网页\n\n' + '正文资料。'.repeat(2000),
                next_offset: null,
              };
        await event('tool', { id, name, label, status: 'succeeded', result });
      }
      const finalTurn = randomUUID();
      await event('text_reset', { turn_id: finalTurn });
      await event('text', { turn_id: finalTurn, delta: finalText });
      await event('text_end', { turn_id: finalTurn });
      const process = await readExecutionProcess(c, userId, {
        id: operationId,
        status: 'succeeded',
        reply: finalText,
      });
      const summary = summarizeProcess(
        process,
        finalText,
        'succeeded',
        new Date().toISOString(),
        finalTurn,
      );
      await c.query(
        "INSERT INTO messages(id,user_id,operation_id,role,content,dedupe_key,process) VALUES($1,$2,$3,'assistant',$4,$5,$6)",
        [
          randomUUID(),
          userId,
          operationId,
          finalText,
          `${operationId}:response:0`,
          JSON.stringify(summary),
        ],
      );
    });
    let reads = 0;
    await page.route(`**/api/operations/${operationId}/process?*`, async (route) => {
      expect(route.request().method()).toBe('GET');
      if (++reads <= 2)
        await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
      else await route.continue();
    });
    await page.goto(fixture.base);
    const process = page.locator(`.execution-process[data-operation-id="${operationId}"]`);
    await expect(process.getByRole('button', { name: '展开执行过程' })).toContainText(
      '3 个工具步骤',
    );
    expect(reads).toBe(0);
    await process.getByRole('button', { name: '展开执行过程' }).click();
    await expect(process.locator('.process-tool')).toHaveCount(3);
    await expect(process.locator('.process-error')).toHaveCount(0);
    expect(reads).toBeGreaterThanOrEqual(3);
    await expect(process.getByText('我先检索公开信息，再阅读网页核实来源。')).toBeVisible();
    await process.locator('.process-tool summary').first().click();
    await expect(process.locator('.trace-detail').first()).toContainText('深圳公开会议时间');
    await expect(process.locator('.trace-detail').first()).toContainText(
      'https://example.com/official',
    );
    await page.reload();
    await expect(process.locator('.process-body')).toHaveCount(0);
    await process.getByRole('button', { name: '展开执行过程' }).click();
    await expect(process.locator('.process-tool')).toHaveCount(3);
    await process.locator('.process-tool summary').nth(1).click();
    await expect(process.locator('.trace-detail').nth(1)).toContainText('官方网页');
    await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({
      path: `test-results/e2e-${testInfo.project.name}-web-process-recovered.png`,
      fullPage: true,
    });
  } finally {
    await page.goto('about:blank');
    await fixture.close();
  }
});
