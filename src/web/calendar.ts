import { translate } from './locale';
import { localInput, zonedISO } from './api';

export type CalendarView = 'month' | 'week';
export interface CalendarEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day?: boolean;
  starts_on?: string | null;
  ends_on?: string | null;
  status: 'confirmed' | 'cancelled';
  location?: string;
  notes?: string;
}
export interface CalendarReminder {
  id: string;
  title: string;
  remind_at: string;
  status: 'scheduled' | 'delivered' | 'cancelled';
  event_id?: string | null;
  todo_id?: string | null;
  trigger_kind?: 'absolute' | 'relative';
  relative_to?: 'start' | 'end' | 'planned' | 'due' | null;
  before_minutes?: number | null;
}
export interface CalendarTodo {
  id: string;
  title: string;
  status: 'open' | 'done';
  notes?: string;
  timezone?: string;
  planned_date?: string | null;
  planned_at?: string | null;
  planned_end_at?: string | null;
  due_date?: string | null;
  due_at?: string | null;
  reminders?: CalendarReminder[];
}
export type CalendarItem = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  reminders: CalendarReminder[];
  allDay?: boolean;
  startsOn?: string;
  endsOn?: string;
  placement?: 'planned' | 'due';
} & (
  | { kind: 'event'; source: CalendarEvent }
  | { kind: 'todo'; source: CalendarTodo }
  | { kind: 'reminder'; source: CalendarReminder }
);
export interface DaySegment {
  item: CalendarItem;
  start: number;
  end: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}
export interface PositionedSegment extends DaySegment {
  column: number;
  columns: number;
}

const date = (value: string) => new Date(`${value}T00:00:00Z`);
const key = (value: Date) => value.toISOString().slice(0, 10);
export const weekDay = (value: string) => (date(value).getUTCDay() + 6) % 7;
export const addDays = (value: string, days: number) => key(new Date(+date(value) + days * 864e5));

export function calendarDays(anchor: string, view: CalendarView): string[] {
  if (view === 'week') {
    const monday = addDays(anchor, -weekDay(anchor));
    return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
  }
  const first = `${anchor.slice(0, 7)}-01`;
  const d = date(first);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const count = Math.max(35, Math.ceil((weekDay(first) + last) / 7) * 7);
  const start = addDays(first, -weekDay(first));
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

export function calendarRange(anchor: string, view: CalendarView, timezone: string) {
  const days = calendarDays(anchor, view);
  return {
    days,
    from: zonedISO(`${days[0]}T00:00`, timezone),
    to: zonedISO(`${addDays(days.at(-1)!, 1)}T00:00`, timezone),
  };
}

export function shiftCalendarDate(anchor: string, view: CalendarView, direction: number) {
  if (view === 'week') return addDays(anchor, direction * 7);
  const current = date(anchor);
  const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + direction, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(current.getUTCDate(), last));
  return key(first);
}

export function calendarItems(
  events: CalendarEvent[],
  reminders: CalendarReminder[],
  todos: CalendarTodo[] = [],
  timezone = 'Asia/Shanghai',
): CalendarItem[] {
  const unique = [
    ...new Map(
      [...reminders, ...todos.flatMap((todo) => todo.reminders ?? [])].map((reminder) => [
        reminder.id,
        reminder,
      ]),
    ).values(),
  ].filter((reminder) => reminder.status !== 'cancelled');
  const result: CalendarItem[] = events
    .filter((event) => event.status !== 'cancelled')
    .map((event) => ({
      id: `event:${event.id}`,
      kind: 'event',
      title: event.title,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      source: event,
      reminders: unique.filter((reminder) => reminder.event_id === event.id),
      allDay: !!event.all_day,
      startsOn: event.starts_on ?? undefined,
      endsOn: event.ends_on ?? undefined,
    }));
  for (const todo of todos) {
    const placements: ('planned' | 'due')[] = [];
    const planned =
      todo.planned_date ??
      (todo.planned_at ? localInput(todo.planned_at, timezone).slice(0, 10) : null);
    const due =
      todo.due_date ?? (todo.due_at ? localInput(todo.due_at, timezone).slice(0, 10) : null);
    if (planned) placements.push('planned');
    if (due && due !== planned) placements.push('due');
    for (const placement of placements) {
      const on = placement === 'planned' ? todo.planned_date : todo.due_date;
      const at = placement === 'planned' ? todo.planned_at : todo.due_at;
      result.push({
        id: placement === 'due' && planned ? `todo-due:${todo.id}` : `todo:${todo.id}`,
        kind: 'todo',
        source: todo,
        title: todo.title,
        placement,
        startsAt: at ?? zonedISO(`${on}T00:00`, timezone),
        endsAt: on
          ? zonedISO(`${addDays(on, 1)}T00:00`, timezone)
          : placement === 'planned'
            ? (todo.planned_end_at ?? null)
            : null,
        allDay: !!on,
        startsOn: on ?? undefined,
        endsOn: on ? addDays(on, 1) : undefined,
        reminders: unique.filter((reminder) => reminder.todo_id === todo.id),
      });
    }
  }
  for (const reminder of unique) {
    // An event's notification belongs to its event, including notifications on a different day.
    if (reminder.event_id || reminder.todo_id) continue;
    result.push({
      id: `reminder:${reminder.id}`,
      kind: 'reminder',
      title: reminder.title,
      startsAt: reminder.remind_at,
      endsAt: null,
      source: reminder,
      reminders: [reminder],
    });
  }
  return result.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id),
  );
}

const minuteOfDay = (value: string, timezone: string) => {
  const time = localInput(value, timezone).slice(11, 16);
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
};

export function segmentsForDay(items: CalendarItem[], day: string, timezone: string): DaySegment[] {
  const from = Date.parse(zonedISO(`${day}T00:00`, timezone));
  const to = Date.parse(zonedISO(`${addDays(day, 1)}T00:00`, timezone));
  return items
    .flatMap((item): DaySegment[] => {
      if (item.allDay && item.startsOn && item.endsOn) {
        if (day < item.startsOn || day >= item.endsOn) return [];
        return [
          {
            item,
            start: 0,
            end: 1440,
            continuesBefore: day > item.startsOn,
            continuesAfter: addDays(day, 1) < item.endsOn,
          },
        ];
      }
      const start = Date.parse(item.startsAt),
        end = item.endsAt ? Date.parse(item.endsAt) : start;
      if (item.endsAt ? start >= to || end <= from : start < from || start >= to) return [];
      const startMinute = start < from ? 0 : minuteOfDay(item.startsAt, timezone);
      return [
        {
          item,
          start: startMinute,
          end: item.endsAt
            ? end >= to
              ? 1440
              : Math.max(startMinute, minuteOfDay(item.endsAt, timezone))
            : startMinute,
          continuesBefore: start < from,
          continuesAfter: end > to,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(!!b.item.allDay) - Number(!!a.item.allDay) ||
        a.start - b.start ||
        b.end - a.end ||
        a.item.id.localeCompare(b.item.id),
    );
}

export function positionSegments(segments: DaySegment[]): PositionedSegment[] {
  const result: PositionedSegment[] = [];
  let group: PositionedSegment[] = [],
    lanes: number[] = [],
    groupEnd = -1;
  const finish = () => {
    group.forEach((segment) => {
      segment.columns = lanes.length;
    });
    result.push(...group);
    group = [];
    lanes = [];
    groupEnd = -1;
  };
  for (const segment of [...segments].sort((a, b) => a.start - b.start || b.end - a.end)) {
    // Reserve the minimum readable card height without changing the displayed time or duration.
    const end = Math.max(segment.end, segment.start + 45);
    if (group.length && segment.start >= groupEnd) finish();
    let column = lanes.findIndex((freeAt) => freeAt <= segment.start);
    if (column === -1) column = lanes.length;
    lanes[column] = end;
    groupEnd = Math.max(groupEnd, end);
    group.push({ ...segment, column, columns: 1 });
  }
  finish();
  return result;
}

export function clockTime(minute: number) {
  return `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
}

export function reminderTiming(item: CalendarItem, reminder: CalendarReminder) {
  if (reminder.trigger_kind === 'absolute' && (reminder.event_id || reminder.todo_id))
    return translate('固定时刻提醒');
  if (reminder.trigger_kind === 'relative' && reminder.before_minutes != null) {
    const anchor = {
      start: translate('开始'),
      end: translate('结束'),
      planned: translate('计划'),
      due: translate('截止'),
    }[reminder.relative_to ?? 'start'];
    const minutes = reminder.before_minutes;
    if (minutes === 0) return translate`${anchor}时提醒`;
    const amount =
      minutes % 1440 === 0
        ? translate`${minutes / 1440} 天`
        : minutes % 60 === 0
          ? translate`${minutes / 60} 小时`
          : translate`${minutes} 分钟`;
    return translate`${anchor}前 ${amount}提醒`;
  }
  const minutes = Math.round((Date.parse(item.startsAt) - Date.parse(reminder.remind_at)) / 60000);
  if (!minutes) return translate('到时提醒');
  if (minutes < 0) return translate('开始后提醒');
  if (minutes % 1440 === 0) return translate`提前 ${minutes / 1440} 天提醒`;
  if (minutes % 60 === 0) return translate`提前 ${minutes / 60} 小时提醒`;
  return translate`提前 ${minutes} 分钟提醒`;
}
