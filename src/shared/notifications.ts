export const notificationLabels = {
  reminder: '到时提醒',
  task_result: '任务结果',
  attention: '待你处理',
} as const;

export type NotificationKind = keyof typeof notificationLabels;
export type NotificationObject = 'operation' | 'event' | 'todo' | 'reminder' | 'schedule';

/** Notification previews are plain text, not fragments of a Markdown document. */
export function notificationPreview(text: string, limit = 220) {
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*>]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}
