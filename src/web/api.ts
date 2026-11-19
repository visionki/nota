import { dateLabel } from '../shared/dates';
import { interfaceLocale, translate } from './locale';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export function displayError(error: unknown, fallback = '操作没有完成') {
  const original = error instanceof Error ? error.message : fallback;
  const translated = translate(original);
  if (
    !(error instanceof ApiError) ||
    interfaceLocale() === 'zh-CN' ||
    translated !== original ||
    !/[\p{Script=Han}]/u.test(original)
  )
    return translated;
  if (error.code === 'quota_exhausted')
    return translate('今天的免费额度已用完，北京时间 00:00 重置。');
  if (error.code === 'file_too_large') return translate('文件超过上传大小限制。');
  return translate('无法完成请求，请检查后重试。');
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
      typeof data?.error === 'string' ? data.error : '服务暂时无法处理，请稍后重试。',
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
  if (!value) return translate('未设置');
  return new Date(value).toLocaleString(interfaceLocale(), {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}
export function formatCalendarDate(value: string) {
  if (interfaceLocale() === 'zh-CN') return dateLabel(value);
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
export function duration(n: number) {
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(n % 60)
    .toString()
    .padStart(2, '0')}`;
}
export { localInput, zonedISO } from '../shared/dates';
