/** Timeout only silent I/O. Healthy long-running streams continue. */
export function idleFetch(
  timeoutMs: number,
  upstream: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, options = {}) => {
    const controller = new AbortController();
    const parent = options.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
    };
    const arm = () => {
      clear();
      timer = setTimeout(() => controller.abort(new Error('模型连接长时间无响应')), timeoutMs);
    };
    arm();
    try {
      const response = await upstream(input, { ...options, signal });
      clear();
      if (!response.body) return response;
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(stream) {
            arm();
            try {
              const n = await reader.read();
              clear();
              if (n.done) {
                reader.releaseLock();
                stream.close();
              } else stream.enqueue(n.value);
            } catch (e) {
              clear();
              stream.error(e);
            }
          },
          async cancel(reason) {
            clear();
            controller.abort(reason);
            await reader.cancel(reason);
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } catch (e) {
      clear();
      throw e;
    }
  };
}
