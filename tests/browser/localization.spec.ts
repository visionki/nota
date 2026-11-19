import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { testDatabase } from '../helpers.js';

test.use({ locale: 'en-GB' });

test('device language, saved override, GMI credit, and public plan availability', async ({
  page,
}) => {
  const fixture = await testDatabase();
  const config = { ...fixture.config, BILLING_MODE: 'disabled' as const, FREE_DAILY_LIMIT: 10 };
  const { app } = await createApp(config, fixture.db);
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    config.APP_URL = base;

    await page.goto(base);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Sign in to Nota' })).toBeVisible();
    const logo = page.getByRole('img', { name: 'GMI Clouder' });
    await expect(logo).toBeVisible();
    await expect
      .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByText('Model inference from GMI Cloud')).toBeVisible();
    await expect(
      page.getByText('For chat, voice note analysis, and background queries.'),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(page.viewportSize()!.width);

    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh-CN');
    await expect(page.getByRole('button', { name: '登录 Nota' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.reload();
    await expect(page.getByRole('button', { name: '登录 Nota' })).toBeVisible();
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('auto');
    await expect(page.getByRole('button', { name: 'Sign in to Nota' })).toBeVisible();

    const registration = await page.request.post(base + '/api/auth/register', {
      data: {
        email: `locale-${randomUUID()}@nota.test`,
        password: randomUUID(),
        name: 'Nota tester',
      },
    });
    expect(registration.ok()).toBe(true);
    await page.goto(base + '/#billing');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nota Free' })).toBeVisible();
    await expect(
      page.getByText('10 new AI requests a day, reset at midnight Beijing time.'),
    ).toBeVisible();
    let activationCalls = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/billing/demo-upgrade')) activationCalls++;
    });
    await page.getByRole('button', { name: 'About Pro' }).click();
    await expect(
      page.getByText('Pro is in development. The Free plan is available today.'),
    ).toBeVisible();
    expect(activationCalls).toBe(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(page.viewportSize()!.width);

    await page.goto(base + '/#settings');
    const language = page.getByRole('combobox', { name: 'Interface language' });
    await expect(language).toBeVisible();
    await language.selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '个人资料' })).toBeVisible();
    await expect(page.getByText('GMI Cloud 提供模型推理')).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await fixture.close();
  }
});
