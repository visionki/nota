import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, emit, owned, type Client } from './db.js';
import { digest } from './auth.js';
import { addCalendarDays, localInput, zonedISO } from '../shared/dates.js';

export const iso = z.string().datetime({ offset: true });
const calendarDate = z.iso.date();
const nullableTime = iso.nullable().optional();
const nullableDate = calendarDate.nullable().optional();
export const reminderSettingSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    remind_at: iso.optional(),
    before_minutes: z.number().int().min(0).max(525600).optional(),
    relative_to: z.enum(['start', 'end', 'planned', 'due']).optional(),
  })
  .strict();
const inlineReminders = z.array(reminderSettingSchema).max(10).optional();
export const todoSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(3000).default(''),
  timezone: z.string().optional(),
  planned_date: nullableDate,
  planned_at: nullableTime,
  planned_end_at: nullableTime,
  due_date: nullableDate,
  due_at: nullableTime,
  recording_id: z.uuid().nullable().optional(),
  reminders: inlineReminders,
});
export const todoPatchSchema = todoSchema
  .omit({ reminders: true, notes: true })
  .partial()
  .extend({
    notes: z.string().max(3000).optional(),
    status: z.enum(['open', 'done']).optional(),
    add_reminders: inlineReminders,
  })
  .strict()
  .refine((a) => Object.keys(a).length > 0, '请提供需要修改的待办字段');
export const eventSchema = z.object({
  title: z.string().trim().min(1).max(300),
  starts_at: iso.optional(),
  ends_at: nullableTime,
  all_day: z.boolean().optional(),
  starts_on: nullableDate,
  ends_on: nullableDate,
  timezone: z.string().optional(),
  location: z.string().max(400).default(''),
  notes: z.string().max(3000).default(''),
  person_id: z.uuid().nullable().optional(),
  recording_id: z.uuid().nullable().optional(),
  reminders: inlineReminders,
});
export const eventPatchSchema = eventSchema
  .omit({ reminders: true, location: true, notes: true })
  .partial()
  .extend({
    location: z.string().max(400).optional(),
    notes: z.string().max(3000).optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    add_reminders: inlineReminders,
  })
  .strict()
  .refine((a) => Object.keys(a).length > 0, '请提供需要修改的日程字段');
export const reminderSchema = reminderSettingSchema
  .extend({
    title: z.string().trim().min(1).max(300),
    event_id: z.uuid().nullable().optional(),
    todo_id: z.uuid().nullable().optional(),
  })
  .strip();

export function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new AppError(400, '时区无效');
  }
  return tz;
}
async function timezoneFor(c: Client, u: string, timezone?: string) {
  return validTimezone(
    timezone ??
      (await c.query('SELECT timezone FROM users WHERE id=$1', [u])).rows[0]?.timezone ??
      'Asia/Shanghai',
  );
}
function key(op: string | undefined, kind: string, input: object) {
  return `${op ?? randomUUID()}:${kind}:${digest(JSON.stringify(input))}`;
}
function normalizeTodo(a: any, old: any = {}) {
  const value = { ...old, ...a };
  for (const prefix of ['planned', 'due']) {
    const date = `${prefix}_date`,
      at = `${prefix}_at`;
    if (a[date] != null && a[at] != null) throw new AppError(400, '仅日期和具体时间请选择一种精度');
    if (a[date] != null) {
      value[at] = null;
      if (prefix === 'planned') value.planned_end_at = null;
    }
    if (a[at] != null) value[date] = null;
    value[date] ??= null;
    value[at] ??= null;
  }
  value.planned_end_at ??= null;
  if (a.planned_at === null && a.planned_end_at == null) value.planned_end_at = null;
  if (
    value.planned_end_at &&
    (!value.planned_at || Date.parse(value.planned_end_at) <= +new Date(value.planned_at))
  )
    throw new AppError(400, '计划结束时间必须晚于计划开始时间');
  return value;
}
function normalizeEvent(a: any, old: any = {}) {
  const value = { ...old, ...a };
  value.all_day = a.all_day ?? (a.starts_on != null ? true : (old.all_day ?? false));
  if (value.all_day) {
    value.starts_on =
      a.starts_on ??
      old.starts_on ??
      (value.starts_at ? localInput(value.starts_at, value.timezone).slice(0, 10) : null);
    if (!value.starts_on) throw new AppError(400, '全天日程需要开始日期 starts_on');
    const span =
      old.starts_on && old.ends_on
        ? Math.round((Date.parse(old.ends_on) - Date.parse(old.starts_on)) / 864e5)
        : 1;
    value.ends_on =
      a.ends_on ??
      (a.starts_on && a.starts_on !== old.starts_on
        ? addCalendarDays(value.starts_on, span)
        : old.ends_on) ??
      addCalendarDays(value.starts_on, 1);
    if (value.ends_on <= value.starts_on)
      throw new AppError(400, '结束日期（不含当日）必须晚于开始日期');
    value.starts_at = zonedISO(`${value.starts_on}T00:00`, value.timezone);
    value.ends_at = zonedISO(`${value.ends_on}T00:00`, value.timezone);
  } else {
    if (!value.starts_at || (old.all_day && a.starts_at === undefined))
      throw new AppError(400, '日程需要明确的开始时间；只有日期请用全天日程');
    if (a.starts_on != null || a.ends_on != null) throw new AppError(400, '仅日期字段用于全天日程');
    value.starts_on = value.ends_on = null;
    value.ends_at = old.all_day && a.ends_at === undefined ? null : (value.ends_at ?? null);
    if (value.ends_at && +new Date(value.ends_at) <= +new Date(value.starts_at))
      throw new AppError(400, '结束时间必须晚于开始时间');
  }
  return value;
}
async function inline(
  c: Client,
  u: string,
  entity: any,
  kind: 'event' | 'todo',
  settings: any[] = [],
  op?: string,
) {
  const reminders = [];
  for (const setting of settings)
    reminders.push(
      await createReminder(
        c,
        u,
        { ...setting, title: setting.title ?? entity.title, [`${kind}_id`]: entity.id },
        op,
      ),
    );
  return { ...entity, reminders };
}
export async function createTodo(c: Client, u: string, input: unknown, op?: string) {
  const parsed = todoSchema.parse(input);
  const a = normalizeTodo({ ...parsed, timezone: await timezoneFor(c, u, parsed.timezone) });
  if (a.recording_id) await owned(c, 'recordings', a.recording_id, u);
  const { rows } = await c.query(
    'INSERT INTO todos(id,user_id,title,notes,due_at,recording_id,operation_id,dedupe_key,timezone,planned_date,planned_at,planned_end_at,due_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *',
    [
      randomUUID(),
      u,
      a.title,
      a.notes,
      a.due_at,
      a.recording_id ?? null,
      op ?? null,
      key(op, 'todo', parsed),
      a.timezone,
      a.planned_date,
      a.planned_at,
      a.planned_end_at,
      a.due_date,
    ],
  );
  const result = await inline(c, u, rows[0], 'todo', a.reminders, op);
  await emit(c, u, 'changed', { entity: 'todo', id: result.id }, op);
  return result;
}
export async function createEvent(c: Client, u: string, input: unknown, op?: string) {
  const parsed = eventSchema.parse(input);
  const a = normalizeEvent({ ...parsed, timezone: await timezoneFor(c, u, parsed.timezone) });
  if (a.recording_id) await owned(c, 'recordings', a.recording_id, u);
  if (a.person_id) await owned(c, 'people', a.person_id, u);
  const { rows } = await c.query(
    'INSERT INTO calendar_events(id,user_id,title,starts_at,ends_at,timezone,location,notes,person_id,recording_id,operation_id,dedupe_key,all_day,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *',
    [
      randomUUID(),
      u,
      a.title,
      a.starts_at,
      a.ends_at,
      a.timezone,
      a.location,
      a.notes,
      a.person_id ?? null,
      a.recording_id ?? null,
      op ?? null,
      key(op, 'event', parsed),
      a.all_day,
      a.starts_on,
      a.ends_on,
    ],
  );
  const result = await inline(c, u, rows[0], 'event', a.reminders, op);
  await emit(c, u, 'changed', { entity: 'event', id: result.id }, op);
  return result;
}

/** All writers lock the parent before its reminders, including the delivery worker. */
async function parent(c: Client, u: string, table: 'calendar_events' | 'todos', id: string) {
  const value = (
    await c.query(`SELECT * FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, u])
  ).rows[0];
  if (!value) throw new AppError(404, '事项不存在或无访问权限');
  return value;
}
function anchorAt(value: any, kind: 'event' | 'todo', relativeTo: string) {
  if (kind === 'event') {
    if (value.all_day) return null;
    return relativeTo === 'start' ? value.starts_at : relativeTo === 'end' ? value.ends_at : null;
  }
  return relativeTo === 'planned' ? value.planned_at : relativeTo === 'due' ? value.due_at : null;
}
async function reminderValue(c: Client, u: string, a: any, old?: any) {
  const eventId = a.event_id === undefined ? (old?.event_id ?? null) : a.event_id;
  const todoId = a.todo_id === undefined ? (old?.todo_id ?? null) : a.todo_id;
  if (eventId && todoId) throw new AppError(400, '提醒只能关联一个日程或一个待办');
  const kind = eventId ? 'event' : todoId ? 'todo' : null;
  const value = kind
    ? await parent(c, u, kind === 'event' ? 'calendar_events' : 'todos', eventId ?? todoId)
    : null;
  if (value && (kind === 'event' ? value.status !== 'confirmed' : value.status !== 'open'))
    throw new AppError(409, '关联事项已取消或已完成，不能设置提醒');
  let triggerKind = old?.trigger_kind ?? 'absolute';
  let relativeTo = a.relative_to ?? old?.relative_to ?? (kind === 'event' ? 'start' : 'planned');
  let beforeMinutes = a.before_minutes ?? old?.before_minutes ?? null;
  let remindAt = a.remind_at ?? old?.remind_at;
  const linksChanged = old && (eventId !== old.event_id || todoId !== old.todo_id);
  if (a.before_minutes !== undefined || (a.relative_to !== undefined && a.remind_at === undefined))
    triggerKind = 'relative';
  else if (a.remind_at !== undefined || !kind) triggerKind = 'absolute';
  if (triggerKind === 'relative') {
    const anchor = value && anchorAt(value, kind!, relativeTo);
    if (!anchor || beforeMinutes === null)
      throw new AppError(
        400,
        '相对提醒需要关联事项的明确时刻和提前分钟数；仅日期事项请设置具体提醒时间',
      );
    if (a.before_minutes !== undefined || a.relative_to !== undefined || linksChanged || !old) {
      const computed = new Date(+new Date(anchor) - beforeMinutes * 60000).toISOString();
      if (a.remind_at && Math.abs(Date.parse(a.remind_at) - Date.parse(computed)) > 1000)
        throw new AppError(400, `提醒时间与提前量不一致，计算结果是 ${computed}`);
      remindAt = computed;
    }
  } else {
    relativeTo = null;
    beforeMinutes = null;
  }
  if (!remindAt) throw new AppError(400, '需要具体提醒时间，或关联事项及提前分钟数');
  if (+new Date(remindAt) < Date.now() - 60000)
    throw new AppError(400, '提醒时间已经过去，请确认日期和时区');
  return {
    title: a.title ?? old?.title,
    event_id: eventId,
    todo_id: todoId,
    remind_at: remindAt,
    trigger_kind: triggerKind,
    relative_to: relativeTo,
    before_minutes: beforeMinutes,
  };
}
export async function createReminder(c: Client, u: string, input: unknown, op?: string) {
  const parsed = reminderSchema.parse(input);
  const a = await reminderValue(c, u, parsed);
  const { rows } = await c.query(
    'INSERT INTO reminders(id,user_id,title,remind_at,event_id,todo_id,operation_id,dedupe_key,trigger_kind,relative_to,before_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(user_id,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *',
    [
      randomUUID(),
      u,
      a.title,
      a.remind_at,
      a.event_id,
      a.todo_id,
      op ?? null,
      key(op, 'reminder', parsed),
      a.trigger_kind,
      a.relative_to,
      a.before_minutes,
    ],
  );
  await emit(c, u, 'changed', { entity: 'reminder', id: rows[0].id }, op);
  return rows[0];
}
export async function createArrangement(c: Client, u: string, input: unknown) {
  const raw = z
    .object({ kind: z.enum(['event', 'todo', 'reminder']).default('event') })
    .passthrough()
    .parse(input);
  const { kind, before_minutes, ...body } = raw;
  if (kind === 'reminder') {
    const reminder = await createReminder(c, u, {
      ...body,
      remind_at: body.remind_at ?? body.starts_at,
    });
    return { kind, event: null, todo: null, reminder };
  }
  const settings = body.reminders ?? (before_minutes == null ? undefined : [{ before_minutes }]);
  const value =
    kind === 'event'
      ? await createEvent(c, u, { ...body, reminders: settings })
      : await createTodo(c, u, { ...body, reminders: settings });
  return {
    kind,
    event: kind === 'event' ? value : null,
    todo: kind === 'todo' ? value : null,
    reminder: value.reminders[0] ?? null,
  };
}
async function syncReminders(c: Client, u: string, kind: 'event' | 'todo', old: any, value: any) {
  const { rows } = await c.query(
    `SELECT * FROM reminders WHERE user_id=$1 AND ${kind}_id=$2 AND status='scheduled' FOR UPDATE`,
    [u, value.id],
  );
  for (const r of rows) {
    const active = kind === 'event' ? value.status === 'confirmed' : value.status === 'open';
    let status = active ? 'scheduled' : 'cancelled';
    let remindAt = r.remind_at;
    if (active && r.trigger_kind === 'relative') {
      const anchor = anchorAt(value, kind, r.relative_to);
      if (!anchor) status = 'cancelled';
      else {
        remindAt = new Date(+new Date(anchor) - r.before_minutes * 60000);
        if (+remindAt < Date.now() - 60000) status = 'cancelled';
      }
    }
    await c.query(
      'UPDATE reminders SET status=$3,remind_at=$4,title=$5 WHERE id=$1 AND user_id=$2',
      [r.id, u, status, remindAt, r.title === old.title ? value.title : r.title],
    );
    await emit(c, u, 'changed', { entity: 'reminder', id: r.id });
  }
}
export async function updateTodo(c: Client, u: string, id: string, input: unknown) {
  const a = todoPatchSchema.parse(input);
  const old = await parent(c, u, 'todos', id);
  const value = normalizeTodo(a, old);
  validTimezone(value.timezone);
  if (value.recording_id) await owned(c, 'recordings', value.recording_id, u);
  const { rows } = await c.query(
    'UPDATE todos SET title=$3,notes=$4,due_at=$5,status=$6,updated_at=now(),timezone=$7,planned_date=$8,planned_at=$9,planned_end_at=$10,due_date=$11,recording_id=$12 WHERE id=$1 AND user_id=$2 RETURNING *',
    [
      id,
      u,
      value.title,
      value.notes,
      value.due_at,
      value.status,
      value.timezone,
      value.planned_date,
      value.planned_at,
      value.planned_end_at,
      value.due_date,
      value.recording_id,
    ],
  );
  await syncReminders(c, u, 'todo', old, rows[0]);
  await inline(c, u, rows[0], 'todo', a.add_reminders);
  await emit(c, u, 'changed', { entity: 'todo', id });
  return getTodo(c, u, id);
}
export async function updateEvent(c: Client, u: string, id: string, input: unknown) {
  const a = eventPatchSchema.parse(input);
  const old = await parent(c, u, 'calendar_events', id);
  validTimezone(a.timezone ?? old.timezone);
  const value = normalizeEvent(a, old);
  validTimezone(value.timezone);
  if (value.person_id) await owned(c, 'people', value.person_id, u);
  if (value.recording_id) await owned(c, 'recordings', value.recording_id, u);
  const { rows } = await c.query(
    'UPDATE calendar_events SET title=$3,starts_at=$4,ends_at=$5,timezone=$6,location=$7,notes=$8,status=$9,person_id=$10,recording_id=$11,all_day=$12,starts_on=$13,ends_on=$14,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *',
    [
      id,
      u,
      value.title,
      value.starts_at,
      value.ends_at,
      value.timezone,
      value.location,
      value.notes,
      value.status,
      value.person_id,
      value.recording_id,
      value.all_day,
      value.starts_on,
      value.ends_on,
    ],
  );
  await syncReminders(c, u, 'event', old, rows[0]);
  await inline(c, u, rows[0], 'event', a.add_reminders);
  await emit(c, u, 'changed', { entity: 'event', id });
  return getEvent(c, u, id);
}
export async function getEvent(c: Client, u: string, id: string) {
  const value = await owned(c, 'calendar_events', id, u);
  return {
    ...value,
    reminders: (
      await c.query(
        'SELECT * FROM reminders WHERE user_id=$1 AND event_id=$2 ORDER BY remind_at,id',
        [u, id],
      )
    ).rows,
  };
}
export async function getTodo(c: Client, u: string, id: string) {
  const value = await owned(c, 'todos', id, u);
  return {
    ...value,
    reminders: (
      await c.query(
        'SELECT * FROM reminders WHERE user_id=$1 AND todo_id=$2 ORDER BY remind_at,id',
        [u, id],
      )
    ).rows,
  };
}
export async function listTodos(c: Client, u: string) {
  return (
    await c.query(
      `SELECT t.*,COALESCE((SELECT jsonb_agg(r ORDER BY r.remind_at,r.id) FROM reminders r WHERE r.user_id=t.user_id AND r.todo_id=t.id),'[]'::jsonb) AS reminders FROM todos t WHERE user_id=$1 ORDER BY status,COALESCE(planned_at,due_at,planned_date::timestamp AT TIME ZONE timezone,due_date::timestamp AT TIME ZONE timezone) NULLS LAST,created_at DESC LIMIT 300`,
      [u],
    )
  ).rows;
}
export async function updateReminder(c: Client, u: string, id: string, input: unknown) {
  const a = reminderSchema
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, '请提供需要修改的提醒字段')
    .parse(input);
  const previous = await owned(c, 'reminders', id, u);
  // Acquire both old and new parent locks in a stable order before locking the reminder.
  const parents = new Map<string, 'calendar_events' | 'todos'>();
  if (previous.event_id) parents.set(previous.event_id, 'calendar_events');
  if (previous.todo_id) parents.set(previous.todo_id, 'todos');
  if (a.event_id) parents.set(a.event_id, 'calendar_events');
  if (a.todo_id) parents.set(a.todo_id, 'todos');
  for (const [parentId, table] of [...parents].sort(([a], [b]) => a.localeCompare(b)))
    await parent(c, u, table, parentId);
  const old = (
    await c.query('SELECT * FROM reminders WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, u])
  ).rows[0];
  if (old.status !== 'scheduled')
    throw new AppError(409, '提醒已投递或已取消，无法修改；已发送的通知不能撤回');
  const value = await reminderValue(c, u, a, old);
  const { rows } = await c.query(
    'UPDATE reminders SET title=$3,remind_at=$4,event_id=$5,todo_id=$6,trigger_kind=$7,relative_to=$8,before_minutes=$9 WHERE id=$1 AND user_id=$2 RETURNING *',
    [
      id,
      u,
      value.title,
      value.remind_at,
      value.event_id,
      value.todo_id,
      value.trigger_kind,
      value.relative_to,
      value.before_minutes,
    ],
  );
  await emit(c, u, 'changed', { entity: 'reminder', id });
  return rows[0];
}
export async function cancelReminder(c: Client, u: string, id: string) {
  const { rows } = await c.query(
    "UPDATE reminders SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='scheduled' RETURNING *",
    [id, u],
  );
  if (!rows[0]) throw new AppError(404, '提醒不存在或已经结束');
  await emit(c, u, 'changed', { entity: 'reminder', id });
  return rows[0];
}
export async function agenda(c: Client, u: string, from: string, to: string) {
  if (
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(to) - Date.parse(from) > 93 * 864e5 ||
    Date.parse(to) <= Date.parse(from)
  )
    throw new AppError(400, '查询时间范围需在 93 天以内');
  const timezone = await timezoneFor(c, u);
  const fromDate = localInput(from, timezone).slice(0, 10),
    toLocal = localInput(to, timezone);
  const toDate =
    toLocal.slice(11) === '00:00' ? toLocal.slice(0, 10) : addCalendarDays(toLocal.slice(0, 10), 1);
  const events = (
    await c.query(
      "SELECT * FROM calendar_events WHERE user_id=$1 AND status='confirmed' AND ((all_day AND starts_on<$5::date AND ends_on>$4::date) OR (NOT all_day AND starts_at<$3 AND COALESCE(ends_at,starts_at+interval '1 millisecond')>$2)) ORDER BY starts_at,id",
      [u, from, to, fromDate, toDate],
    )
  ).rows;
  const todos = (
    await c.query(
      `SELECT * FROM todos WHERE user_id=$1 AND ((planned_at >= $2 AND planned_at < $3) OR (planned_at < $2 AND planned_end_at > $2) OR (due_at >= $2 AND due_at < $3) OR (planned_date >= $4::date AND planned_date < $5::date) OR (due_date >= $4::date AND due_date < $5::date) OR (planned_date IS NULL AND planned_at IS NULL AND due_date IS NULL AND due_at IS NULL)) ORDER BY status,created_at DESC`,
      [u, from, to, fromDate, toDate],
    )
  ).rows;
  const reminders = (
    await c.query(
      'SELECT * FROM reminders WHERE user_id=$1 AND ((remind_at >= $2 AND remind_at < $3) OR event_id=ANY($4::uuid[]) OR todo_id=ANY($5::uuid[])) ORDER BY remind_at,id',
      [u, from, to, events.map((x) => x.id), todos.map((x) => x.id)],
    )
  ).rows;
  const eventReminders = reminders.filter((r) => r.event_id),
    todoReminders = reminders.filter((r) => r.todo_id);
  return {
    events,
    todos: todos.map((t) => ({ ...t, reminders: todoReminders.filter((r) => r.todo_id === t.id) })),
    reminders: reminders.filter(
      (r) => +new Date(r.remind_at) >= Date.parse(from) && +new Date(r.remind_at) < Date.parse(to),
    ),
    event_reminders: eventReminders,
    todo_reminders: todoReminders,
  };
}
