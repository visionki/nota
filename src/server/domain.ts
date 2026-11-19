import { plainTranscriptSegments } from '../shared/notes.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { AppError, emit, owned, type Client } from './db.js';
import { digest } from './auth.js';
import { MemoryService } from './memory.js';
import { sourceRecallAllowed } from './memory-sql.js';
import type { RecallMode } from './memory-policy.js';
export {
  iso,
  todoSchema,
  todoPatchSchema,
  eventSchema,
  eventPatchSchema,
  reminderSchema,
  validTimezone,
  createTodo,
  createEvent,
  createReminder,
  createArrangement,
  updateTodo,
  updateEvent,
  getEvent,
  getTodo,
  listTodos,
  updateReminder,
  cancelReminder,
  agenda,
} from './agenda-domain.js';
import { iso, validTimezone } from './agenda-domain.js';
export const scheduleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(3000),
  notification_policy: z.enum(['always', 'on_change']).default('always'),
  run_at: iso.optional(),
  cron: z.string().max(100).optional(),
  timezone: z.string().default('Asia/Shanghai'),
});
export async function createSchedule(c: Client, u: string, input: unknown) {
  const a = scheduleSchema.parse(input);
  validTimezone(a.timezone);
  if (!a.cron && !a.run_at) throw new AppError(400, '需要触发时间或 cron 表达式');
  let next: Date;
  if (a.cron) {
    try {
      const expression = CronExpressionParser.parse(a.cron, { tz: a.timezone });
      next = expression.next().toDate();
      const second = expression.next().toDate();
      if (+second - +next < 600000) throw new Error('frequency');
    } catch {
      throw new AppError(400, 'Cron 无效，或触发间隔小于 10 分钟');
    }
  } else {
    next = new Date(a.run_at!);
    if (+next < Date.now()) throw new AppError(400, '触发时间必须在未来');
  }
  const { rows } = await c.query(
    'INSERT INTO schedules(id,user_id,title,prompt,cron,timezone,next_run_at,notification_policy) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [randomUUID(), u, a.title, a.prompt, a.cron ?? null, a.timezone, next, a.notification_policy],
  );
  await emit(c, u, 'changed', { entity: 'schedule', id: rows[0].id });
  return rows[0];
}
export async function searchHistory(
  c: Client,
  u: string,
  input: {
    query: string;
    person?: string;
    from?: string;
    to?: string;
    as_of?: string;
    limit?: number;
    mode?: RecallMode;
  },
) {
  const { query, person, from, to } = input;
  const mode = input.mode ?? (from || to ? 'history' : 'current');
  const limit = Math.min(12, Math.max(1, input.limit ?? 8));
  const term = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const dates = [from ?? '1970-01-01T00:00:00Z', to ?? '2100-01-01T00:00:00Z'];
  const recordings = (
    await c.query(
      `SELECT id,title,created_at,recorded_at,recorded_timezone,version,duration_seconds,transcript,summary,segments FROM recordings r WHERE user_id=$1 AND ${sourceRecallAllowed("'recording'", 'r.id', 'r.version')} AND (title ILIKE $2 OR transcript ILIKE $2 OR summary ILIKE $2) AND coalesce(recorded_at,created_at) BETWEEN $3 AND $4 AND ($6::text IS NULL OR transcript ILIKE '%'||$6||'%') ${mode === 'current' ? "AND NOT EXISTS(SELECT 1 FROM memory_evidence me JOIN facts mf ON mf.id=me.fact_id AND mf.user_id=me.user_id WHERE me.user_id=r.user_id AND me.source_kind='recording' AND me.source_id=r.id AND me.source_version=r.version AND mf.status IN ('superseded','pending'))" : ''} ORDER BY coalesce(recorded_at,created_at) DESC LIMIT $5`,
      [u, term, ...dates, limit, person ?? null],
    )
  ).rows.map((r) => {
    const index = r.transcript.toLowerCase().indexOf(query.toLowerCase());
    return {
      ...r,
      transcript: r.transcript.slice(Math.max(0, index - 160), Math.max(0, index - 160) + 3500),
      segments: plainTranscriptSegments(r.segments).slice(0, 20),
      source_url: `/recordings/${r.id}?version=${r.version}`,
    };
  });
  const service = new MemoryService();
  const facts = await service.list(c, u, {
    query,
    person,
    from,
    to,
    as_of: input.as_of,
    limit,
    mode,
  });
  const pending = (
    await service.list(c, u, { query, person, mode: 'history', include_pending: true, limit: 200 })
  )
    .filter((f) => f.status === 'pending')
    .slice(0, limit);
  const pending_memories = pending.length
    ? (
        await c.query(
          "SELECT id AS candidate_id,fact_id,subject,predicate,value,person_name,organization,status,source_refs FROM memory_candidates WHERE user_id=$1 AND fact_id=ANY($2::uuid[]) AND status IN ('needs_identity','needs_confirmation')",
          [u, pending.map((f) => f.id)],
        )
      ).rows
    : [];
  const messages = (
    await c.query(
      `SELECT id,role,content,created_at FROM messages m WHERE user_id=$1 AND role='user' AND ${sourceRecallAllowed("'message'", 'm.id', '1')} AND content ILIKE $2 AND created_at BETWEEN $3 AND $4 ${mode === 'current' ? "AND NOT EXISTS(SELECT 1 FROM memory_evidence me JOIN facts mf ON mf.id=me.fact_id AND mf.user_id=me.user_id WHERE me.user_id=m.user_id AND me.source_kind='message' AND me.source_id=m.id AND mf.status IN ('superseded','pending'))" : ''} ORDER BY seq DESC LIMIT $5`,
      [u, term, ...dates, limit],
    )
  ).rows.map((r) => ({ ...r, content: r.content.slice(0, 2000) }));
  const business_objects = (
    await c.query(
      `
    SELECT * FROM (
      SELECT 'event' AS object_kind,id,title,status,starts_at AS at,starts_on AS on_date,timezone,location,person_id FROM calendar_events
      WHERE user_id=$1 AND (title ILIKE $2 OR location ILIKE $2 OR notes ILIKE $2) AND ($5::boolean OR status='confirmed')
      AND ($3::timestamptz IS NULL OR starts_at>=$3) AND ($4::timestamptz IS NULL OR starts_at<$4)
      UNION ALL
      SELECT 'todo',id,title,status,coalesce(planned_at,due_at),coalesce(planned_date,due_date),timezone,'' AS location,NULL::uuid FROM todos
      WHERE user_id=$1 AND (title ILIKE $2 OR notes ILIKE $2) AND ($5::boolean OR status='open')
      AND ($3::timestamptz IS NULL OR coalesce(planned_at,due_at,planned_date::timestamp AT TIME ZONE timezone,due_date::timestamp AT TIME ZONE timezone)>=$3)
      AND ($4::timestamptz IS NULL OR coalesce(planned_at,due_at,planned_date::timestamp AT TIME ZONE timezone,due_date::timestamp AT TIME ZONE timezone)<$4)
      UNION ALL
      SELECT 'reminder',id,title,status,remind_at,NULL::date,'UTC','',NULL::uuid FROM reminders
      WHERE user_id=$1 AND title ILIKE $2 AND ($5::boolean OR status='scheduled') AND ($3::timestamptz IS NULL OR remind_at>=$3) AND ($4::timestamptz IS NULL OR remind_at<$4)
    ) objects ORDER BY at DESC NULLS LAST LIMIT $6`,
      [u, term, from ?? null, to ?? null, mode !== 'current', limit],
    )
  ).rows;
  return {
    recordings,
    facts,
    pending_memories,
    messages,
    business_objects,
    business_note:
      '日程、待办、提醒是权威业务记录，日期和状态以它们为准；不要把业务字段复制为长期事实。关系记忆可通过业务ID关联。',
    recall_mode: mode,
    note:
      mode === 'current'
        ? '当前事实优先；原文是出处，不代表所有旧陈述仍有效。历史问题使用history，变化过程使用timeline。'
        : '包含历史版本与归档记忆；以状态、有效日期和替换关系区分当时与现在，日期未知不冒充发生日期。',
  };
}
export { ics } from './agenda-export.js';
