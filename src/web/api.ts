export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  headers.set('X-Nota-Request', '1');
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  } catch {
    options.signal?.throwIfAborted();
    throw new ApiError('网络暂时不可用，录音可以保存在本机，联网后再上传。', 0);
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    if (response.ok)
      throw new ApiError('服务返回的数据不完整，请稍后重试。', 502, 'invalid_response');
  }
  if (!response.ok) {
    if (response.status === 401 && !['/me', '/auth/login', '/auth/register'].includes(path)) {
      window.dispatchEvent(new Event('nota:unauthorized'));
    }
    throw new ApiError(
      data?.error ?? '服务暂时无法处理，请稍后重试。',
      response.status,
      data?.code,
    );
  }
  return data;
}
export const post = (path: string, body: unknown = {}) =>
  api(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = (path: string, body: unknown) =>
  api(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string) => api(path, { method: 'DELETE' });
export function formatDate(
  value: string | Date | undefined,
  timezone = 'Asia/Shanghai',
  options: Intl.DateTimeFormatOptions = {},
) {
  if (!value) return '未设置';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}
export function duration(n: number) {
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(n % 60)
    .toString()
    .padStart(2, '0')}`;
}
export { localInput, zonedISO } from '../shared/dates';
