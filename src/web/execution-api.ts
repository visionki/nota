import type { ExecutionProcessState } from '../shared/execution.js';
import { api, ApiError } from './api';

function retryDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Only retry read-only process snapshots; business mutations are never replayed here. */
export async function loadExecutionProcess(
  operationId: string,
  selection: { messageId?: string; cycle?: number },
  signal: AbortSignal,
): Promise<ExecutionProcessState> {
  const query = new URLSearchParams();
  if (selection.messageId) query.set('message_id', selection.messageId);
  else if (selection.cycle !== undefined) query.set('cycle', String(selection.cycle));
  const delays = [400, 1200, 2400];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const data = await api<{ process: ExecutionProcessState }>(
        `/operations/${operationId}/process?${query}`,
        { signal },
      );
      if (!Array.isArray(data?.process?.entries) || !/^\d+$/.test(data.process.cursor))
        throw new ApiError('过程记录暂时不完整，请稍后重试。', 502, 'invalid_process');
      return data.process;
    } catch (error) {
      signal.throwIfAborted();
      const transient =
        error instanceof ApiError &&
        (error.status === 0 || error.status === 408 || error.status >= 500);
      if (!transient || attempt === delays.length) throw error;
      await retryDelay(delays[attempt], signal);
    }
  }
}
