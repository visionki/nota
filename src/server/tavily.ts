import { isIP } from 'node:net';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './db.js';

function publicWebUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      host.includes('.') &&
      !isIP(host) &&
      !/\.(localhost|local|internal|test)\.?$/i.test(host)
    );
  } catch {
    return false;
  }
}
const searchInput = z.object({
  query: z.string().trim().min(1).max(400),
  limit: z.number().int().min(1).max(10).default(5),
  time_range: z.enum(['day', 'week', 'month', 'year']).optional(),
  domains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    )
    .min(1)
    .max(10)
    .optional(),
});
const readInput = z.object({
  url: z
    .string()
    .trim()
    .max(2000)
    .refine(publicWebUrl, '请提供不含账号密码的公开 HTTP(S) 网页域名 URL'),
  offset: z.number().int().min(0).default(0),
});
const searchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      published_date: z.string().nullish(),
    }),
  ),
});
const extractResponse = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string() })),
});
const invalidResponse = () =>
  new AppError(502, '联网服务返回了无法识别的数据，请稍后重试。', 'web_invalid_response');

export class Tavily {
  constructor(readonly config?: Pick<Config, 'TAVILY_API_KEY' | 'TAVILY_TIMEOUT_MS'>) {}

  private async request(path: '/search' | '/extract', body: object, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.config?.TAVILY_API_KEY)
      throw new AppError(503, '尚未配置 Tavily，暂时无法联网检索。', 'web_unconfigured');
    const timeout = AbortSignal.timeout(this.config.TAVILY_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(`https://api.tavily.com${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.TAVILY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status))
          throw new AppError(503, 'Tavily 密钥不可用，请检查服务端配置。', 'web_auth_failed');
        if ([402, 432].includes(response.status))
          throw new AppError(503, 'Tavily 检索额度已用完，请检查服务额度。', 'web_quota_exhausted');
        if (response.status === 429)
          throw new AppError(503, '联网检索请求较多，请稍后重试。', 'web_rate_limited');
        throw new AppError(
          502,
          `联网服务请求未成功（${response.status}），请稍后重试。`,
          'web_upstream_failed',
        );
      }
      try {
        return await response.json();
      } catch {
        requestSignal.throwIfAborted();
        throw invalidResponse();
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new AppError(504, '联网检索超时，请稍后重试。', 'web_timeout');
      if (error instanceof AppError) throw error;
      // Upstream errors may contain credentials or private response bodies.
      throw new AppError(502, '暂时无法连接联网检索服务，请稍后重试。', 'web_connection_failed');
    }
  }

  async search(input: unknown, signal?: AbortSignal) {
    const a = searchInput.parse(input);
    const parsed = searchResponse.safeParse(
      await this.request(
        '/search',
        {
          query: a.query,
          max_results: a.limit,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          include_published_date: true,
          time_range: a.time_range,
          include_domains: a.domains,
        },
        signal,
      ),
    );
    if (!parsed.success) throw invalidResponse();
    return {
      provider: 'tavily',
      external_content: true,
      query: a.query,
      retrieved_at: new Date().toISOString(),
      results: parsed.data.results
        .filter((r) => publicWebUrl(r.url))
        .slice(0, a.limit)
        .map((r) => ({
          title: r.title.slice(0, 300),
          url: r.url,
          snippet: r.content.slice(0, 2500),
          source_date: r.published_date ?? null,
        })),
    };
  }

  async read(input: unknown, signal?: AbortSignal) {
    const a = readInput.parse(input);
    const parsed = extractResponse.safeParse(
      await this.request(
        '/extract',
        {
          urls: [a.url],
          extract_depth: 'basic',
          format: 'markdown',
        },
        signal,
      ),
    );
    if (!parsed.success) throw invalidResponse();
    const page = parsed.data.results.find((r) => publicWebUrl(r.url) && r.raw_content.trim());
    if (!page)
      throw new AppError(502, '未能读取网页正文，页面可能无法公开访问。', 'web_extract_failed');
    const end = Math.min(a.offset + 12000, page.raw_content.length);
    return {
      provider: 'tavily',
      external_content: true,
      url: page.url,
      retrieved_at: new Date().toISOString(),
      content: page.raw_content.slice(a.offset, end),
      offset: a.offset,
      total_chars: page.raw_content.length,
      next_offset: end < page.raw_content.length ? end : null,
    };
  }
}
