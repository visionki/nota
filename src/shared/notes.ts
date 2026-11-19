export const NOTE_INSTRUCTION =
  '请整理这条个人口述便签，保存摘要，提取我明确交办的待办、日程和提醒，并保留人物、项目及约定的来源原文。';

// Items saved before the memo-only update retain their original request content
// when retried, so a lost upload acknowledgement cannot create a second task.
export const LEGACY_UPLOAD_INSTRUCTION =
  '请整理这段录音，保存摘要，提取明确的待办、日程、提醒，以及有原文证据的人物和关系。';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Existing recordings may contain retired metadata; expose only source text and time. */
export function plainTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item.text !== 'string') return [];
    const start = Number(item.start),
      end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return [];
    return [{ start, end, text: item.text }];
  });
}
