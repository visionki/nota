import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  CalendarDays,
  CheckCircle2,
  Circle,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Plus,
} from 'lucide-react';
import { formatDate, localInput, patch } from './api';
import { addCalendarDays, dateLabel as shortDate } from '../shared/dates';
import { Button, IconButton, Modal, useNota } from './ui';
import {
  calendarDays,
  calendarItems,
  clockTime,
  positionSegments,
  reminderTiming,
  segmentsForDay,
  shiftCalendarDate,
  weekDay,
  type CalendarEvent,
  type CalendarItem,
  type CalendarReminder,
  type CalendarTodo,
  type CalendarView,
  type DaySegment,
} from './calendar';
import './agenda.css';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const hourHeight = 64;
const dateLabel = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日`;
const notificationStatus = (reminder: CalendarReminder) =>
  reminder.status === 'delivered' ? '已通知' : '待通知';
const segmentTime = (segment: DaySegment) =>
  segment.item.allDay
    ? '全天'
    : segment.item.endsAt
      ? `${clockTime(segment.start)}–${clockTime(segment.end)}`
      : clockTime(segment.start);

function NotificationSummary({ item }: { item: CalendarItem }) {
  const next = item.reminders.find((reminder) => reminder.status === 'scheduled');
  if (next)
    return (
      <span>
        <Bell size={12} />
        {reminderTiming(item, next)}
      </span>
    );
  if (item.reminders.length)
    return (
      <span>
        <Bell size={12} />
        已通知
      </span>
    );
  return <span>未设提醒</span>;
}

export function AgendaCalendar({
  selectedDate,
  onSelectDate,
  view,
  onViewChange,
  events,
  reminders,
  todos,
  list = false,
  loading,
  onCancelReminder,
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  view: CalendarView;
  onViewChange: (view: CalendarView) => void;
  events: CalendarEvent[];
  reminders: CalendarReminder[];
  todos: CalendarTodo[];
  list?: boolean;
  loading: boolean;
  onCancelReminder: (reminder: CalendarReminder) => void;
}) {
  const { user, openCreate, action } = useNota();
  const timezone: string = user.timezone;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const scroll = useRef<HTMLDivElement>(null);
  const [showDone, setShowDone] = useState(false);
  const items = useMemo(
    () =>
      calendarItems(events, reminders, todos, timezone).filter(
        (item) => showDone || item.kind !== 'todo' || item.source.status !== 'done',
      ),
    [events, reminders, todos, timezone, showDone],
  );
  const days = calendarDays(selectedDate, view);
  const today = localInput(now, timezone).slice(0, 10);
  const daySegments = segmentsForDay(items, selectedDate, timezone);
  const active = items.find((item) => item.id === selectedId);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (view !== 'week' || loading || !scroll.current) return;
    const segments = segmentsForDay(items, selectedDate, timezone);
    const first = segments.find((segment) => !segment.item.allDay)?.start ?? 8 * 60;
    scroll.current.scrollTop = Math.max(0, (first / 60) * hourHeight - hourHeight);
  }, [view, selectedDate, loading, timezone]);

  const selectDate = (value: string) => {
    onSelectDate(value);
    setSelectedId(null);
  };
  const selectItem = (item: CalendarItem, date: string) => {
    onSelectDate(date);
    setSelectedId(item.id);
  };
  const saved = (value: string) => {
    if (value) onSelectDate(value.slice(0, 10));
  };
  const create = () => {
    openCreate('arrangement', { starts_on: selectedDate, all_day: true, onSaved: saved });
  };
  const title =
    view === 'month'
      ? `${selectedDate.slice(0, 4)} 年 ${Number(selectedDate.slice(5, 7))} 月`
      : `${days[0].slice(0, 4)} 年 ${dateLabel(days[0])}–${dateLabel(days.at(-1)!)}`;
  const cancelReminder = (reminder: CalendarReminder) => {
    setSelectedId(null);
    onCancelReminder(reminder);
  };
  const itemTitle = (item: CalendarItem) =>
    `${item.placement === 'due' ? '截止 · ' : ''}${item.title}`;
  const toggleTodo = (todo: CalendarTodo) =>
    action(
      () => patch(`/todos/${todo.id}`, { status: todo.status === 'done' ? 'open' : 'done' }),
      todo.status === 'done' ? '已恢复待办' : '已完成待办，未来提醒已取消',
    );
  const mark = (item: CalendarItem) =>
    item.kind === 'todo' ? (
      item.source.status === 'done' ? (
        <CheckCircle2 size={14} aria-hidden="true" />
      ) : (
        <Circle size={14} aria-hidden="true" />
      )
    ) : item.kind === 'reminder' ? (
      <Bell size={13} aria-hidden="true" />
    ) : null;
  const dayEntry = (segment: DaySegment, day: string) => (
    <div
      className={`agenda-day-entry ${segment.item.kind === 'todo' && segment.item.source.status === 'done' ? 'is-done' : ''}`}
      key={segment.item.id}
    >
      {segment.item.kind === 'todo' ? (
        <label className="agenda-task-toggle">
          <input
            type="checkbox"
            className="agenda-task-check"
            checked={segment.item.source.status === 'done'}
            aria-label={`${segment.item.source.status === 'done' ? '恢复' : '完成'}待办 ${segment.item.title}`}
            onChange={() => {
              if (segment.item.kind === 'todo') void toggleTodo(segment.item.source);
            }}
          />
        </label>
      ) : (
        <span className="agenda-entry-kind">
          {segment.item.kind === 'reminder' ? <Bell size={15} /> : <CalendarDays size={15} />}
        </span>
      )}
      <button
        type="button"
        data-item-id={segment.item.id}
        className={`agenda-day-item ${segment.item.kind === 'reminder' ? 'is-point' : ''}`}
        onClick={() => selectItem(segment.item, day)}
      >
        <time>{segment.item.allDay ? '全天' : clockTime(segment.start)}</time>
        <span className="agenda-day-item-content">
          <strong>{itemTitle(segment.item)}</strong>
          <span className="agenda-day-meta">
            {segment.item.kind === 'todo'
              ? `待办 · ${segment.item.placement === 'due' ? '截止' : '计划'}`
              : segment.item.kind === 'reminder'
                ? '独立提醒'
                : '日程'}{' '}
            · {segmentTime(segment)}
            {segment.continuesBefore ? ' · 接上日' : ''}
            {segment.continuesAfter ? ' · 至次日' : ''}
          </span>
          <span className="agenda-day-meta">
            <NotificationSummary item={segment.item} />
          </span>
        </span>
      </button>
    </div>
  );

  return (
    <section className="agenda-calendar" aria-label="安排日历" aria-busy={loading}>
      <div className="agenda-calendar-toolbar">
        <div className="agenda-date-controls">
          <h2 aria-live="polite">{title}</h2>
          <div className="agenda-date-buttons">
            <IconButton
              label={view === 'month' ? '上一月' : '上一周'}
              onClick={() => selectDate(shiftCalendarDate(selectedDate, view, -1))}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <IconButton
              label={view === 'month' ? '下一月' : '下一周'}
              onClick={() => selectDate(shiftCalendarDate(selectedDate, view, 1))}
            >
              <ChevronRight size={18} />
            </IconButton>
            <Button
              variant="secondary"
              onClick={() => selectDate(localInput(new Date(), timezone).slice(0, 10))}
            >
              今天
            </Button>
          </div>
        </div>
        <div className="agenda-view-controls">
          <label className="agenda-completed-toggle">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />
            显示已完成
          </label>
          <span className="agenda-timezone">
            {timezone === 'Asia/Shanghai' ? '北京时间' : timezone}
          </span>
          <div className="agenda-view-switch" role="group" aria-label="日历视图">
            <button
              type="button"
              aria-pressed={view === 'month'}
              onClick={() => onViewChange('month')}
            >
              月视图
            </button>
            <button
              type="button"
              aria-pressed={view === 'week'}
              onClick={() => onViewChange('week')}
            >
              周视图
            </button>
          </div>
        </div>
      </div>
      {list ? (
        <div className="agenda-all-list panel">
          <p className="agenda-list-note">
            当前{view === 'week' ? '周' : '月'}
            的日程和待办。计划与截止跨日期时分别标注，均指向同一待办。
          </p>
          {days
            .filter((day) => segmentsForDay(items, day, timezone).length)
            .map((day) => (
              <section className="agenda-list-day" key={day}>
                <h3>
                  {day} · {weekdays[weekDay(day)]}
                </h3>
                <div className="agenda-day-items">
                  {segmentsForDay(items, day, timezone).map((segment) => dayEntry(segment, day))}
                </div>
              </section>
            ))}
          {todos.some(
            (todo) =>
              !todo.planned_at &&
              !todo.planned_date &&
              !todo.due_at &&
              !todo.due_date &&
              (showDone || todo.status === 'open'),
          ) && (
            <section className="agenda-list-day">
              <h3>未安排日期</h3>
              {todos
                .filter(
                  (todo) =>
                    !todo.planned_at &&
                    !todo.planned_date &&
                    !todo.due_at &&
                    !todo.due_date &&
                    (showDone || todo.status === 'open'),
                )
                .map((todo) => (
                  <div className="agenda-undated-task" key={todo.id}>
                    <input
                      type="checkbox"
                      aria-label={`${todo.status === 'done' ? '恢复' : '完成'}待办 ${todo.title}`}
                      checked={todo.status === 'done'}
                      onChange={() => void toggleTodo(todo)}
                    />
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => openCreate('todo', todo)}
                    >
                      {todo.title}
                    </button>
                  </div>
                ))}
            </section>
          )}
          {!items.length && !todos.length && (
            <div className="agenda-day-empty">
              <p>还没有事项。</p>
              <Button variant="secondary" onClick={create}>
                <Plus size={15} />
                添加事项
              </Button>
            </div>
          )}
        </div>
      ) : view === 'month' ? (
        <div className="agenda-month-layout">
          <div className="agenda-month" aria-label={`${title}月历`}>
            <div className="agenda-month-weekdays" aria-hidden="true">
              {weekdays.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
            <div className="agenda-month-grid">
              {days.map((day) => {
                const segments = segmentsForDay(items, day, timezone);
                return (
                  <div
                    key={day}
                    data-date={day}
                    className={`agenda-month-cell ${day.slice(0, 7) !== selectedDate.slice(0, 7) ? 'adjacent-month' : ''} ${day === today ? 'is-today' : ''} ${day === selectedDate ? 'is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="agenda-month-date"
                      aria-pressed={day === selectedDate}
                      aria-current={day === today ? 'date' : undefined}
                      aria-label={`${day}，${segments.length} 项安排`}
                      onClick={() => selectDate(day)}
                    >
                      <span>{Number(day.slice(8))}</span>
                      <span className="agenda-date-dots" aria-hidden="true">
                        {segments.slice(0, 3).map((segment) => (
                          <i key={segment.item.id} />
                        ))}
                      </span>
                    </button>
                    <div className="agenda-month-items">
                      {segments.slice(0, 3).map((segment) => {
                        const item = segment.item;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-item-id={item.id}
                            className={`agenda-month-item ${item.kind === 'reminder' ? 'is-point' : 'is-duration'} ${item.kind === 'todo' ? 'is-todo' : ''} ${item.kind === 'todo' && item.source.status === 'done' ? 'is-done' : ''} ${item.kind === 'reminder' && item.source.status === 'delivered' ? 'is-delivered' : ''}`}
                            aria-label={`${day} ${segmentTime(segment)} ${itemTitle(item)}`}
                            title={`${segmentTime(segment)} ${itemTitle(item)}`}
                            onClick={() => selectItem(item, day)}
                          >
                            {mark(item)}
                            <time>
                              {item.allDay
                                ? '全天'
                                : segment.continuesBefore
                                  ? '延续'
                                  : clockTime(segment.start)}
                            </time>
                            <span>{itemTitle(item)}</span>
                          </button>
                        );
                      })}
                      {segments.length > 3 && (
                        <button
                          type="button"
                          className="agenda-month-more"
                          onClick={() => selectDate(day)}
                          aria-label={`查看 ${day} 全部 ${segments.length} 项安排`}
                        >
                          还有 {segments.length - 3} 项
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <aside className="agenda-day-panel" aria-label="当天安排">
            <div className="agenda-day-heading">
              <div>
                <h3>{dateLabel(selectedDate)}</h3>
                <p>
                  {weekdays[weekDay(selectedDate)]} · {daySegments.length} 项安排
                </p>
              </div>
              <IconButton label="为所选日期新建安排" onClick={create}>
                <Plus size={18} />
              </IconButton>
            </div>
            <div className="agenda-day-items" aria-live="polite">
              {daySegments.map((segment) => dayEntry(segment, selectedDate))}
              {!daySegments.length && !loading && (
                <div className="agenda-day-empty">
                  <CalendarDays size={25} strokeWidth={1.4} />
                  <p>这一天还没有安排。</p>
                  <button type="button" className="text-button" onClick={create}>
                    添加一件事 <Plus size={14} />
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="agenda-expand-week"
              onClick={() => onViewChange('week')}
            >
              展开本周时间轴 <ChevronRight size={15} />
            </button>
          </aside>
        </div>
      ) : (
        <div className="agenda-week-panel">
          <div
            className="agenda-week-scroll"
            ref={scroll}
            role="region"
            aria-label="每周时间安排，可上下滚动"
            tabIndex={0}
          >
            <div className="agenda-week-header">
              <span className="agenda-week-zone" aria-hidden="true">
                <Clock3 size={14} />
              </span>
              {days.map((day, index) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={day === selectedDate}
                  aria-current={day === today ? 'date' : undefined}
                  aria-label={`选择 ${day} ${weekdays[index]}`}
                  className={`${day === selectedDate ? 'is-selected' : ''} ${day === today ? 'is-today' : ''}`}
                  onClick={() => selectDate(day)}
                >
                  <span>{weekdays[index]}</span>
                  <strong>{Number(day.slice(8))}</strong>
                </button>
              ))}
            </div>
            <div className="agenda-week-all-day">
              <span className="agenda-week-zone">全天</span>
              {days.map((day) => (
                <div
                  key={day}
                  data-date={day}
                  className={`agenda-all-day-column ${day === selectedDate ? 'is-selected' : ''}`}
                >
                  {segmentsForDay(items, day, timezone)
                    .filter((segment) => segment.item.allDay)
                    .map(({ item }) => (
                      <button
                        type="button"
                        data-item-id={item.id}
                        className={`agenda-month-item is-duration ${item.kind === 'todo' ? 'is-todo' : ''} ${item.kind === 'todo' && item.source.status === 'done' ? 'is-done' : ''}`}
                        key={item.id}
                        onClick={() => selectItem(item, day)}
                        aria-label={`${day} 全天 ${itemTitle(item)}`}
                      >
                        {mark(item)}
                        <span>{itemTitle(item)}</span>
                      </button>
                    ))}
                </div>
              ))}
            </div>
            <div className="agenda-week-body">
              <div className="agenda-hour-labels" aria-hidden="true">
                {Array.from({ length: 25 }, (_, hour) => (
                  <time key={hour} style={{ top: hour * hourHeight }}>
                    {clockTime(hour * 60)}
                  </time>
                ))}
              </div>
              {days.map((day) => {
                const positioned = positionSegments(
                  segmentsForDay(items, day, timezone).filter((segment) => !segment.item.allDay),
                );
                const currentTime = localInput(now, timezone).slice(11, 16);
                const currentMinute =
                  Number(currentTime.slice(0, 2)) * 60 + Number(currentTime.slice(3));
                return (
                  <div
                    key={day}
                    data-date={day}
                    className={`agenda-week-column ${day === selectedDate ? 'is-selected' : ''} ${day === today ? 'is-today' : ''}`}
                    aria-label={`${day} 的时间安排`}
                  >
                    {positioned.map((segment) => (
                      <button
                        key={segment.item.id}
                        type="button"
                        data-item-id={segment.item.id}
                        className={`agenda-time-item ${segment.item.kind === 'reminder' ? 'is-point' : 'is-duration'} ${segment.item.kind === 'todo' ? 'is-todo' : ''} ${segment.item.kind === 'todo' && segment.item.source.status === 'done' ? 'is-done' : ''} ${segment.item.kind === 'reminder' && segment.item.source.status === 'delivered' ? 'is-delivered' : ''}`}
                        style={{
                          top: (segment.start / 60) * hourHeight + 12,
                          height: Math.max(44, ((segment.end - segment.start) / 60) * hourHeight),
                          left: `calc(${(segment.column / segment.columns) * 100}% + 3px)`,
                          width: `calc(${100 / segment.columns}% - 6px)`,
                        }}
                        aria-label={`${day} ${segmentTime(segment)} ${itemTitle(segment.item)}`}
                        title={`${segmentTime(segment)} ${itemTitle(segment.item)}`}
                        onClick={() => selectItem(segment.item, day)}
                      >
                        <strong className="agenda-item-title">
                          {mark(segment.item)}
                          {itemTitle(segment.item)}
                        </strong>
                        <time>
                          {segmentTime(segment)}
                          {segment.continuesBefore ? ' · 接上日' : ''}
                          {segment.continuesAfter ? ' · 至次日' : ''}
                        </time>
                      </button>
                    ))}
                    {day === today && (
                      <div
                        className="agenda-now-line"
                        style={{ top: (currentMinute / 60) * hourHeight + 12 }}
                        aria-label={`当前时间 ${currentTime}`}
                      >
                        <span />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="agenda-week-footer">
            <span>
              {dateLabel(selectedDate)} ·{' '}
              {daySegments.length ? `${daySegments.length} 项安排` : '暂无安排'}
            </span>
            <button type="button" className="text-button" onClick={create}>
              <Plus size={14} /> 添加安排
            </button>
          </div>
        </div>
      )}
      <div className="agenda-calendar-footnote">
        <div className="agenda-calendar-legend">
          <span>
            <i className="agenda-duration-mark" />
            日程
          </span>
          <span>
            <Circle size={13} />
            待办
          </span>
          <span>
            <Bell size={13} />
            独立提醒
          </span>
        </div>
        <span>提醒属于事项设置，通过站内通知送达</span>
      </div>
      {active && (
        <Modal title={active.title} onClose={() => setSelectedId(null)}>
          <div className="agenda-detail">
            <div className="agenda-detail-time">
              <CalendarDays size={18} />
              <div>
                <strong>
                  {active.allDay && active.startsOn
                    ? `${shortDate(active.startsOn)} · 全天 / 仅日期`
                    : formatDate(active.startsAt, timezone)}
                </strong>
                {active.allDay &&
                active.endsOn &&
                active.startsOn &&
                addCalendarDays(active.startsOn, 1) !== active.endsOn ? (
                  <span>至 {shortDate(addCalendarDays(active.endsOn, -1))}</span>
                ) : !active.allDay && active.endsAt ? (
                  <span>至 {formatDate(active.endsAt, timezone)}</span>
                ) : null}
                <small>
                  {active.kind === 'todo' ? '待办' : active.kind === 'event' ? '日程' : '独立提醒'}{' '}
                  · {timezone}
                </small>
              </div>
            </div>
            {active.kind === 'event' && active.source.location && (
              <p className="agenda-detail-location">
                <MapPin size={16} />
                {active.source.location}
              </p>
            )}
            {active.kind === 'event' && active.source.notes && (
              <p className="agenda-detail-notes">{active.source.notes}</p>
            )}
            {active.kind === 'todo' && (
              <div className="agenda-todo-detail">
                <p>
                  计划：
                  {active.source.planned_date
                    ? shortDate(active.source.planned_date)
                    : active.source.planned_at
                      ? formatDate(active.source.planned_at, timezone)
                      : '未安排'}
                  {active.source.planned_end_at
                    ? ` 至 ${formatDate(active.source.planned_end_at, timezone)}`
                    : ''}
                </p>
                <p>
                  截止：
                  {active.source.due_date
                    ? shortDate(active.source.due_date)
                    : active.source.due_at
                      ? formatDate(active.source.due_at, timezone)
                      : '未设置'}
                </p>
                {active.source.notes && (
                  <p className="agenda-detail-notes">{active.source.notes}</p>
                )}
              </div>
            )}
            <div className="agenda-detail-reminders">
              <h3>
                <Bell size={16} />
                提醒设置
              </h3>
              {active.reminders.map((reminder) => (
                <div className="agenda-notification" key={reminder.id}>
                  <div>
                    <strong>{reminderTiming(active, reminder)}</strong>
                    <time>{formatDate(reminder.remind_at, timezone)}</time>
                    <span
                      className={`agenda-notification-status ${reminder.status === 'delivered' ? 'is-delivered' : ''}`}
                    >
                      {notificationStatus(reminder)}
                    </span>
                  </div>
                  {reminder.status === 'scheduled' && (
                    <div className="agenda-notification-actions">
                      {active.kind !== 'reminder' && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setSelectedId(null);
                            openCreate('reminder', { ...reminder, parent_item: active.source });
                          }}
                        >
                          修改
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => cancelReminder(reminder)}
                      >
                        {active.kind === 'reminder' ? '取消安排' : '取消提醒'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!active.reminders.length && <p className="muted">尚未设置提醒。</p>}
              {(active.kind === 'event' ||
                (active.kind === 'todo' && active.source.status === 'open')) && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setSelectedId(null);
                    openCreate('reminder', {
                      ...(active.kind === 'event'
                        ? { event_id: active.source.id }
                        : { todo_id: active.source.id }),
                      title: active.title,
                      parent_item: active.source,
                    });
                  }}
                >
                  <Plus size={14} />
                  添加提醒
                </button>
              )}
            </div>
            <footer className="modal-actions">
              <Button variant="secondary" onClick={() => setSelectedId(null)}>
                关闭
              </Button>
              {active.kind === 'todo' && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const result = await toggleTodo(active.source);
                    if (result) setSelectedId(null);
                  }}
                >
                  {active.source.status === 'done' ? '恢复待办' : '完成待办'}
                </Button>
              )}
              {(active.kind !== 'reminder' || active.source.status === 'scheduled') && (
                <Button
                  onClick={() => {
                    setSelectedId(null);
                    openCreate(active.kind, {
                      ...active.source,
                      onSaved: saved,
                    });
                  }}
                >
                  编辑{active.kind === 'todo' ? '待办' : active.kind === 'event' ? '日程' : '提醒'}
                </Button>
              )}
            </footer>
          </div>
        </Modal>
      )}
    </section>
  );
}
