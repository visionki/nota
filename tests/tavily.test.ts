import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, safeError } from '../src/server/config.js';
import { Tavily } from '../src/server/tavily.js';

const config = loadConfig({
  COOKIE_SECRET: 'a'.repeat(32),
  TAVILY_API_KEY: 'tvly-test-private-key',
  TAVILY_TIMEOUT_MS: 20000,
});
const signal = () => new AbortController().signal;
const result = {
  title: '公开资料',
  url: 'https://example.com/article',
  content: '有来源的搜索片段',
  published_date: '2026-11-12',
};
function mockFetch(data: unknown, status = 200) {
  const mock = vi.fn().mockImplementation(async () => Response.json(data, { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tavily web retrieval', () => {
  it('applies filters, uses basic search and bounds context to public sources', async () => {
    const fetch = mockFetch({
      results: [
        { ...result, url: 'javascript:alert(1)' },
        { ...result, url: 'http://127.0.0.1/private' },
        { ...result, content: '原文'.repeat(3000), api_key: config.TAVILY_API_KEY },
        result,
        result,
      ],
      answer: '不应使用的生成答案',
    });
    const data = await new Tavily(config).search(
      { query: '  最新公开资料  ', limit: 2, time_range: 'week', domains: ['EXAMPLE.COM'] },
      signal(),
    );
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(request.headers.Authorization).toBe(`Bearer ${config.TAVILY_API_KEY}`);
    expect(request.redirect).toBe('error');
    expect(JSON.parse(request.body)).toMatchObject({
      query: '最新公开资料',
      max_results: 2,
      search_depth: 'basic',
      time_range: 'week',
      include_domains: ['example.com'],
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
    });
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toEqual({
      title: result.title,
      url: result.url,
      snippet: '原文'.repeat(1250),
      source_date: '2026-11-12',
    });
    expect(data.external_content).toBe(true);
    expect(JSON.stringify(data)).not.toContain(config.TAVILY_API_KEY);
    expect(JSON.stringify(data)).not.toContain('不应使用的生成答案');
  });
  it('keeps an empty search distinct from a service failure', async () => {
    const fetch = mockFetch({ results: [] });
    expect(
      (await new Tavily(config).search({ query: '没有结果的查询' }, signal())).results,
    ).toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0][1].body).max_results).toBe(5);
  });
  it.each([
    { query: ' ' },
    { query: 'a'.repeat(401) },
    { query: 'test', limit: 11 },
    { query: 'test', limit: 1.5 },
    { query: 'test', time_range: 'forever' },
    { query: 'test', domains: ['https://example.com/path'] },
  ])('rejects invalid input before calling the paid API: %j', async (input) => {
    const fetch = mockFetch({ results: [] });
    await expect(new Tavily(config).search(input, signal())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports missing configuration without making a request', async () => {
    const fetch = mockFetch({ results: [] });
    await expect(new Tavily().search({ query: 'test' }, signal())).rejects.toMatchObject({
      code: 'web_unconfigured',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'web_auth_failed'],
    [429, 'web_rate_limited'],
    [432, 'web_quota_exhausted'],
    [500, 'web_upstream_failed'],
  ])('handles HTTP %i without exposing upstream secrets', async (status, code) => {
    mockFetch({ error: `echoed key=${config.TAVILY_API_KEY}` }, status as number);
    const error = await new Tavily(config).search({ query: 'test' }, signal()).catch((e) => e);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(config.TAVILY_API_KEY);
  });
  it('rejects malformed responses instead of claiming successful retrieval', async () => {
    mockFetch({ results: [{ title: 'missing content' }] });
    await expect(new Tavily(config).search({ query: 'test' }, signal())).rejects.toMatchObject({
      code: 'web_invalid_response',
    });
  });
  it('does not expose transport errors containing credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(config.TAVILY_API_KEY)));
    const error = await new Tavily(config).search({ query: 'test' }, signal()).catch((e) => e);
    expect(error.code).toBe('web_connection_failed');
    expect(error.message).not.toContain(config.TAVILY_API_KEY);
    expect(safeError(new Error(`credential=${config.TAVILY_API_KEY}`), config)).toBe(
      'credential=[redacted]',
    );
  });
  it('cancels an in-flight request when the operation is cancelled', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, request) =>
          new Promise((_resolve, reject) => {
            requestSignal = request.signal;
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const pending = new Tavily(config).search({ query: 'test' }, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });
  it('reports a timeout when the request deadline aborts', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const pending = new Tavily(config).search({ query: 'test' }, signal());
    const assertion = expect(pending).rejects.toMatchObject({ code: 'web_timeout' });
    timeout.abort(new DOMException('Timed out', 'TimeoutError'));
    await assertion;
  });
  it('returns Markdown in bounded pages with a continuation offset', async () => {
    const content = '一'.repeat(12000) + '\n最后一段';
    const fetch = mockFetch({ results: [{ url: result.url, raw_content: content }] });
    const web = new Tavily(config),
      first = await web.read({ url: result.url }, signal());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      urls: [result.url],
      extract_depth: 'basic',
      format: 'markdown',
    });
    expect(first.content).toHaveLength(12000);
    expect(first.next_offset).toBe(12000);
    const rest = await web.read({ url: result.url, offset: first.next_offset }, signal());
    expect(first.content + rest.content).toBe(content);
    expect(rest.next_offset).toBeNull();
    expect(rest.total_chars).toBe(content.length);
  });
  it('handles per-URL extraction failures with HTTP 200', async () => {
    mockFetch({ results: [], failed_results: [{ url: result.url, error: 'access denied' }] });
    await expect(new Tavily(config).read({ url: result.url }, signal())).rejects.toMatchObject({
      code: 'web_extract_failed',
    });
  });
  it.each([
    'file:///etc/passwd',
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
    'https://name:password@example.com',
    'https://private.internal',
  ])('rejects non-public or credential-bearing URLs: %s', async (url) => {
    const fetch = mockFetch({ results: [] });
    await expect(new Tavily(config).read({ url }, signal())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
