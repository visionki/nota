import { describe, expect, it } from 'vitest';
import {
  calendarDays,
  calendarItems,
  calendarRange,
  positionSegments,
  segmentsForDay,
  shiftCalendarDate,
  type CalendarEvent,
  type CalendarReminder,
} from '../src/web/calendar';

const timezone = 'Asia/Shanghai';
const event = (
  id: string,
  start = '2026-11-13T09:00:00+08:00',
  end = '2026-11-13T10:00:00+08:00',
): CalendarEvent => ({ id, title: '看牙齿', starts_at: start, ends_at: end, status: 'confirmed' });
const reminder = (
  id: string,
  date = '2026-11-14T06:00:00+08:00',
  extra: Partial<CalendarReminder> = {},
): CalendarReminder => ({ id, title: '叫我起床', remind_at: date, status: 'scheduled', ...extra });

describe('Calendar navigation and local date ranges', () => {
  it('includes the entire month and adjacent dates with Monday first', () => {
    const november = calendarDays('2026-11-14', 'month');
    expect(november).toHaveLength(42);
    expect(november[0]).toBe('2026-10-26');
    expect(november.at(-1)).toBe('2026-12-06');
    expect(calendarDays('2026-12-14', 'month')).toHaveLength(35);
    expect(calendarDays('2026-11-14', 'week')).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
  });
  it('queries local midnight and a noninclusive end, including DST changes', () => {
    expect(calendarRange('2026-11-14', 'week', timezone)).toMatchObject({
      from: '2026-11-08T16:00:00.000Z',
      to: '2026-11-15T16:00:00.000Z',
    });
    const dst = calendarRange('2026-03-08', 'week', 'America/New_York');
    expect(dst.from).toBe('2026-03-02T05:00:00.000Z');
    expect(dst.to).toBe('2026-03-09T04:00:00.000Z');
  });
  it('clamps month navigation at month end and crosses year boundaries', () => {
    expect(shiftCalendarDate('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(shiftCalendarDate('2024-01-31', 'month', 1)).toBe('2024-02-29');
    expect(shiftCalendarDate('2026-12-31', 'month', 1)).toBe('2027-01-31');
    expect(shiftCalendarDate('2026-12-31', 'week', 1)).toBe('2027-01-07');
  });
});
describe('One arrangement per calendar item', () => {
  it('places independent reminders on their local day and retains notification history', () => {
    const items = calendarItems(
      [],
      [
        reminder('wake'),
        reminder('sent', '2026-11-13T23:22:00+08:00', { status: 'delivered' }),
        reminder('cancelled', undefined, { status: 'cancelled' }),
      ],
    );
    expect(
      segmentsForDay(items, '2026-11-14', timezone).map((segment) => [
        segment.item.title,
        segment.start,
        segment.end,
      ]),
    ).toEqual([['叫我起床', 360, 360]]);
    expect(segmentsForDay(items, '2026-11-13', timezone)[0].item.source.status).toBe('delivered');
  });
  it('attaches event notifications by identity, even across dates, without duplicate cards', () => {
    const linked = reminder('linked', '2026-11-12T09:00:00+08:00', { event_id: 'dentist' });
    const items = calendarItems(
      [event('dentist')],
      [linked, linked, reminder('unrelated', undefined, { title: '看牙齿' })],
    );
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === 'event:dentist')!.reminders).toEqual([linked]);
    expect(segmentsForDay(items, '2026-11-12', timezone)).toHaveLength(0);
    expect(segmentsForDay(items, '2026-11-13', timezone)).toHaveLength(1);
    expect(calendarItems([], [linked])).toHaveLength(0);
  });
  it('clips overnight events to each day and excludes an event from the day it ends at midnight', () => {
    const items = calendarItems(
      [
        event('overnight', '2026-11-13T23:00:00+08:00', '2026-11-14T01:00:00+08:00'),
        event('midnight', '2026-11-13T22:00:00+08:00', '2026-11-14T00:00:00+08:00'),
      ],
      [],
    );
    expect(
      segmentsForDay(items, '2026-11-13', timezone).map((segment) => [
        segment.start,
        segment.end,
        segment.continuesAfter,
      ]),
    ).toEqual([
      [1320, 1440, false],
      [1380, 1440, true],
    ]);
    expect(
      segmentsForDay(items, '2026-11-14', timezone).map((segment) => [
        segment.item.id,
        segment.start,
        segment.end,
        segment.continuesBefore,
      ]),
    ).toEqual([['event:overnight', 0, 60, true]]);
  });
  it('does not lose a continuing event whose start is before the visible range', () => {
    const items = calendarItems(
      [event('continuing', '2026-10-31T23:00:00+08:00', '2026-11-02T01:00:00+08:00')],
      [],
    );
    expect(segmentsForDay(items, '2026-11-01', timezone)).toMatchObject([
      { start: 0, end: 1440, continuesBefore: true, continuesAfter: true },
    ]);
  });
});
describe('Time-axis overlap layout', () => {
  it('keeps simultaneous points and durations inspectable and releases columns after a group', () => {
    const items = calendarItems(
      [
        event('first'),
        event('overlap', '2026-11-13T09:30:00+08:00', '2026-11-13T10:30:00+08:00'),
        event('later', '2026-11-13T11:00:00+08:00', '2026-11-13T12:00:00+08:00'),
      ],
      [reminder('same-time', '2026-11-13T09:30:00+08:00')],
    );
    const layout = positionSegments(segmentsForDay(items, '2026-11-13', timezone));
    expect(layout.slice(0, 3).map((segment) => segment.columns)).toEqual([3, 3, 3]);
    expect(new Set(layout.slice(0, 3).map((segment) => segment.column)).size).toBe(3);
    expect(layout.at(-1)).toMatchObject({ column: 0, columns: 1 });
    expect(layout.find((segment) => segment.item.kind === 'reminder')).toMatchObject({
      start: 570,
      end: 570,
    });
  });
});

describe('Calendar subjects do not depend on notifications', () => {
  it('shows date-only planned tasks and deadlines without inventing clock times or requiring alerts', () => {
    const items = calendarItems(
      [],
      [],
      [
        { id: 'plan', title: '拔智齿', status: 'open', planned_date: '2026-11-27' },
        { id: 'due', title: '提交材料', status: 'open', due_date: '2026-11-27' },
      ],
    );
    expect(
      segmentsForDay(items, '2026-11-27', timezone).map(({ item }) => [
        item.id,
        item.allDay,
        item.placement,
        item.reminders.length,
      ]),
    ).toEqual([
      ['todo:due', true, 'due', 0],
      ['todo:plan', true, 'planned', 0],
    ]);
    expect(segmentsForDay(items, '2026-11-26', timezone)).toHaveLength(0);
  });
  it('attaches all task alerts to their owner and never creates extra entries at notification times', () => {
    const earlier = reminder('earlier', '2026-11-26T09:00:00+08:00', { todo_id: 'task' });
    const sameDay = reminder('same-day', '2026-11-27T09:00:00+08:00', { todo_id: 'task' });
    const items = calendarItems(
      [],
      [earlier, sameDay],
      [
        {
          id: 'task',
          title: '拔智齿',
          status: 'open',
          planned_date: '2026-11-27',
          reminders: [earlier],
        },
      ],
    );
    expect(items).toHaveLength(1);
    expect(items[0].reminders).toHaveLength(2);
    expect(segmentsForDay(items, '2026-11-26', timezone)).toHaveLength(0);
    expect(calendarItems([], [earlier], [])).toHaveLength(0);
  });
  it('distinguishes a task plan from its later deadline, keeping the same underlying task ID', () => {
    const items = calendarItems(
      [],
      [],
      [
        {
          id: 'task',
          title: '准备材料',
          status: 'open',
          planned_at: '2026-11-20T09:00:00+08:00',
          planned_end_at: '2026-11-20T10:00:00+08:00',
          due_date: '2026-11-27',
        },
      ],
    );
    expect(items.map((item) => [item.id, item.placement, item.source.id])).toEqual([
      ['todo:task', 'planned', 'task'],
      ['todo-due:task', 'due', 'task'],
    ]);
    expect(segmentsForDay(items, '2026-11-20', timezone)[0]).toMatchObject({
      start: 540,
      end: 600,
    });
  });
  it('keeps all-day dates stable across viewer timezones and supports events with no end time', () => {
    const items = calendarItems(
      [
        { ...event('day'), all_day: true, starts_on: '2026-11-27', ends_on: '2026-11-28' },
        { ...event('point', '2026-11-27T09:00:00+08:00'), ends_at: null },
      ],
      [],
    );
    expect(
      segmentsForDay(items, '2026-11-27', 'America/Los_Angeles').some(
        (segment) => segment.item.id === 'event:day',
      ),
    ).toBe(true);
    expect(
      segmentsForDay(items, '2026-11-27', timezone).find(
        (segment) => segment.item.id === 'event:point',
      ),
    ).toMatchObject({ start: 540, end: 540 });
  });
});
