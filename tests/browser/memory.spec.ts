import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { testDatabase } from '../helpers.js';
import { createApp } from '../../src/server/app.js';
import { MemoryService } from '../../src/server/memory.js';
import { sourceDocument, saveChunks, evidenceRefs } from '../../src/server/sources.js';

test('Memory current/history/timeline, confirmation, pinning, unknown dates and forgetting work on desktop and mobile', async ({
  page,
}, testInfo) => {
  test.setTimeout(45000);
  const f = await testDatabase(),
    { db, config } = f,
    memory = new MemoryService(),
    { app } = await createApp(config, db);
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    config.APP_URL = base;
    const registration = await page.request.post(base + '/api/auth/register', {
      data: { name: '记忆验收', email: `${randomUUID()}@nota.test`, password: randomUUID() },
    });
    expect(registration.ok()).toBe(true);
    const user = (await registration.json()).user;
    const save = async (
      text: string,
      value: string,
      when: string,
      subject = '青禾项目',
      recording = false,
    ) => {
      const id = randomUUID();
      if (recording)
        await db.query(
          "INSERT INTO recordings(id,user_id,title,storage_key,filename,mime,size_bytes,duration_seconds,transcript,version,status) VALUES($1,$2,'未知日期便签',$3,'test.wav','audio/wav',100,1,$4,1,'ready')",
          [id, user.id, randomUUID(), text],
        );
      else
        await db.query(
          "INSERT INTO messages(id,user_id,role,content,dedupe_key,created_at) VALUES($1,$2,'user',$3,$4,$5)",
          [id, user.id, text, randomUUID(), when],
        );
      const source = await sourceDocument(db, user.id, recording ? 'recording' : 'message', id),
        chunks = await saveChunks(db, user.id, source);
      return db.tx((c) =>
        memory.remember(c, user.id, source, {
          subject,
          predicate: '报价',
          value,
          source_refs: evidenceRefs(source, chunks, text),
        }),
      );
    };
    await save('青禾项目报价8.6万元。', '8.6万元', '2026-11-01T08:00:00Z');
    await save('青禾项目现在改为9万元，之前报价作废。', '9万元', '2026-11-10T08:00:00Z');
    await save('星河项目报价5万元。', '5万元', '2026-11-01T08:00:00Z', '星河项目', true);
    await page.goto(base + '/#memory');
    await expect(page.getByRole('heading', { name: '记得细节，也记得来处。' })).toBeVisible();
    await expect(page.locator('.fact-card')).toHaveCount(2);
    await expect(page.getByText('事实时间未知', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '历史与归档', exact: true }).click();
    await expect(page.locator('.fact-card')).toHaveCount(3);
    await expect(page.getByText('已被替换', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '变化过程', exact: true }).click();
    await expect(page.locator('.fact-card').first()).toContainText('8.6万元');
    await page.getByRole('button', { name: '当前有效', exact: true }).click();
    await page.getByRole('button', { name: '长期保留 青禾项目', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '取消长期保留 青禾项目', exact: true }),
    ).toBeVisible();
    const candidate = await save('青禾项目报价10万元。', '10万元', '2026-11-11T08:00:00Z');
    expect(candidate.status).toBe('needs_confirmation');
    await page.reload();
    await expect(page.getByRole('heading', { name: '需要确认的记忆', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认为当前值', exact: true }).click();
    await expect(page.locator('.fact-card').filter({ hasText: '青禾项目' })).toContainText(
      '10万元',
    );
    await page.getByRole('button', { name: '查看证据 青禾项目', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '青禾项目的证据与变化', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: '查看这段原文', exact: true }),
    ).toHaveCount(3);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: innerWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.width + 1);
    await page.screenshot({
      path: `test-results/memory-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: '移除记忆 青禾项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '忘记这条记忆？', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('.fact-card').filter({ hasText: '青禾项目' })).toHaveCount(0);
    await page.getByRole('button', { name: '历史与归档', exact: true }).click();
    await expect(page.locator('.fact-card').filter({ hasText: '10万元' })).toHaveCount(0);
  } finally {
    await page.close();
    await app.close();
    await f.close();
  }
});
