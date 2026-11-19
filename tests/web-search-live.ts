/** Opt-in acceptance: calls the running Agent and uses GMI/Tavily credits. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, safeError } from '../src/server/config.js';

const config = loadConfig(),
  base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const report: { at: string; base: string; checks: object[]; error?: string } = {
  at: new Date().toISOString(),
  base,
  checks: [],
};
let cookie = '';
async function call(path: string, body?: object) {
  const response = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as any;
  if (!response.ok) throw new Error(`${response.status}: ${data.error ?? 'API request failed'}`);
  if (path === '/auth/register') cookie = response.headers.get('set-cookie')!.split(';')[0];
  return data;
}
async function wait(id: string) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const data = await call(`/operations/${id}`);
    if (['succeeded', 'failed', 'cancelled', 'waiting'].includes(data.operation.status))
      return data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Agent web retrieval timed out');
}
await mkdir('test-results', { recursive: true });
try {
  assert.ok(
    config.GMI_API_KEY && config.TAVILY_API_KEY,
    'Configure GMI_API_KEY and TAVILY_API_KEY first',
  );
  await call('/auth/register', {
    email: `web-live-${randomUUID()}@nota.local`,
    password: randomBytes(24).toString('base64url'),
    name: '联网检索验收',
  });
  for (const step of [
    {
      tool: 'search_web',
      text: '请实际联网搜索 Tavily 官方 Search API 文档，限定 docs.tavily.com 域名，返回 2 条搜索结果，简要说明用途并附上来源链接。',
    },
    {
      tool: 'read_webpage',
      text: '请实际读取 https://docs.tavily.com/documentation/api-credits 这个网页的正文，确认基础搜索和高级搜索每次分别消耗多少 credits，附上来源链接。',
    },
  ]) {
    const start = Date.now();
    const operation = await call('/chat', { text: step.text, idempotency_key: randomUUID() });
    const data = await wait(operation.id);
    assert.equal(
      data.operation.status,
      'succeeded',
      safeError(data.operation.last_error ?? '', config),
    );
    const tool = data.tools.find((t: any) => t.name === step.tool && t.status === 'succeeded');
    assert.ok(tool, `Agent must execute ${step.tool}`);
    const urls =
      step.tool === 'search_web' ? tool.result.results.map((r: any) => r.url) : [tool.result.url];
    assert.ok(urls.length > 0, 'Retrieval must return real sources');
    if (step.tool === 'read_webpage')
      assert.ok(tool.result.content.length > 0, 'Page body must be nonempty');
    assert.ok(
      urls.some((url: string) => data.operation.reply.includes(url)),
      'Final answer must cite a retrieved source',
    );
    assert.ok(
      !JSON.stringify(data).includes(config.TAVILY_API_KEY),
      'Tool receipts must not contain the API key',
    );
    report.checks.push({
      tool: step.tool,
      operationId: operation.id,
      ms: Date.now() - start,
      urls,
      reply: data.operation.reply,
    });
    console.log(`PASS Real Agent ${step.tool} with cited sources`);
  }
} catch (error) {
  report.error = safeError(error, config);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile('test-results/web-search-live-report.json', JSON.stringify(report, null, 2));
}
