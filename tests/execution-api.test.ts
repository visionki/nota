import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/web/api.js';
import { loadExecutionProcess } from '../src/web/execution-api.js';

const snapshot = {
  cycle: 0,
  cursor: '42',
  entries: [
    {
      kind: 'tool',
      id: 'search',
      sequence: '40',
      name: 'search_web',
      status: 'succeeded',
      result: { results: [{ url: 'https://example.com', snippet: '外部资料' }] },
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('Execution process loading', () => {
  it('preserves an empty or plain-text proxy error as an API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 })));
    await expect(api('/operations/test/process')).rejects.toMatchObject({ status: 502 });
  });
  it('automatically recovers from proxy failures and network interruptions', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(Response.json({ process: snapshot }));
    vi.stubGlobal('fetch', fetch);
    const request = loadExecutionProcess(
      'operation',
      { messageId: 'message' },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    expect(await request).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe('/api/operations/operation/process?message_id=message');
    expect(fetch.mock.calls.every((call: any[]) => call[1].method === undefined)).toBe(true);
  });
  it('does not retry a permanent error or overwrite its explanation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: '这次答复不存在或无访问权限' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      loadExecutionProcess('operation', { cycle: 0 }, new AbortController().signal),
    ).rejects.toMatchObject({ status: 404, message: '这次答复不存在或无访问权限' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops after a bounded number of attempts', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const request = loadExecutionProcess('operation', {}, new AbortController().signal);
    const assertion = expect(request).rejects.toBeInstanceOf(ApiError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('aborts pending retries when a process is closed or replaced', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const request = loadExecutionProcess('operation', {}, controller.signal);
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await assertion;
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
