import React, { useState } from 'react';
import { Bell, Check, Plus, Trash2 } from 'lucide-react';
import { api, post, patch, remove, formatDate, localInput, zonedISO } from './api';
import { addCalendarDays, dateLabel } from '../shared/dates';
import { Button, Confirm, Field, Modal, useNota } from './ui';
import type { CalendarReminder } from './calendar';

type Subject = 'event' | 'todo' | 'reminder';
const choices = [
  ['event', '日程'],
  ['todo', '待办'],
  ['reminder', '独立提醒'],
] as const;
const offsets = ['0', '15', '30', '60', '1440'];
const anchorLabels: Record<string, string> = {
  start: '日程开始',
  end: '日程结束',
  planned: '计划执行',
  due: '截止时间',
};

function PrecisionField({
  label,
  prefix,
  value,
  timezone,
  onChange,
}: {
  label: string;
  prefix: string;
  value: any;
  timezone: string;
  onChange: (timed: boolean, text: string) => void;
}) {
  const [timed, setTimed] = useState(!!value?.at);
  const [text, setText] = useState(
    value?.at ? localInput(value.at, timezone) : (value?.date ?? ''),
  );
  return (
    <div className="agenda-precision-field">
      <Field label={`${label}（可选）`}>
        <input
          type={timed ? 'datetime-local' : 'date'}
          name={`${prefix}_${timed ? 'at' : 'date'}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(timed, e.target.value);
          }}
        />
      </Field>
      <label className="checkbox-row agenda-time-option">
        <input
          type="checkbox"
          checked={timed}
          onChange={(e) => {
            const next = e.target.checked;
            const converted = text.slice(0, 10);
            // Switching precision does not silently add a clock time.
            setTimed(next);
            setText(next ? '' : converted);
            onChange(next, next ? '' : converted);
          }}
        />
        <span>指定{label === '计划日期' ? '执行' : '截止'}时刻</span>
      </label>
    </div>
  );
}

function ReminderFields({
  initial,
  anchors,
  standalone = false,
}: {
  initial?: any;
  anchors: string[];
  standalone?: boolean;
}) {
  const relative = initial?.trigger_kind === 'relative';
  const [choice, setChoice] = useState(
    standalone
      ? 'absolute'
      : initial
        ? relative
          ? offsets.includes(String(initial.before_minutes))
            ? String(initial.before_minutes)
            : 'custom'
          : 'absolute'
        : 'none',
  );
  return (
    <div className="agenda-reminder-fields">
      <Field label={standalone ? '提醒方式' : initial ? '提醒方式' : '提醒我'}>
        <select name="alert_mode" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {!standalone && !initial && <option value="none">不提醒</option>}
          {anchors.length > 0 && (
            <>
              <option value="0">到时提醒</option>
              <option value="15">提前 15 分钟</option>
              <option value="30">提前 30 分钟</option>
              <option value="60">提前 1 小时</option>
              <option value="1440">提前 1 天</option>
              <option value="custom">自定义提前量</option>
            </>
          )}
          <option value="absolute">固定时刻提醒</option>
        </select>
      </Field>
      {!['none', 'absolute'].includes(choice) && (
        <>
          <Field label="提醒基准">
            <select
              name="relative_to"
              defaultValue={
                anchors.includes(initial?.relative_to) ? initial.relative_to : anchors[0]
              }
            >
              {anchors.map((anchor) => (
                <option value={anchor} key={anchor}>
                  {anchorLabels[anchor]}
                </option>
              ))}
            </select>
          </Field>
          {choice === 'custom' && (
            <Field label="提前分钟数">
              <input
                type="number"
                name="before_minutes"
                min={0}
                max={525600}
                step={1}
                required
                defaultValue={initial?.before_minutes ?? 0}
              />
            </Field>
          )}
        </>
      )}
      {choice === 'absolute' && (
        <Field label="提醒时间">
          <input
            name="remind_at"
            type="datetime-local"
            required
            defaultValue={
              initial?.remind_at
                ? localInput(initial.remind_at, initial.timezone ?? 'Asia/Shanghai')
                : ''
            }
          />
        </Field>
      )}
      {choice !== 'none' && (
        <p className="field-hint">
          {choice === 'absolute'
            ? '固定时刻不随事项改期。'
            : '事项改期后，按提前量重新计算提醒时间。'}
        </p>
      )}
    </div>
  );
}

function reminderInput(values: Record<string, FormDataEntryValue>) {
  const mode = String(values.alert_mode ?? 'none');
  if (mode === 'none') return null;
  if (mode === 'absolute') return { remind_at: String(values.remind_at ?? '') };
  return {
    before_minutes: mode === 'custom' ? Number(values.before_minutes) : Number(mode),
    relative_to: String(values.relative_to),
  };
}

export function AgendaEditor({
  kind,
  initial,
  onClose,
}: {
  kind: string;
  initial?: any;
  onClose: () => void;
}) {
  const { user, action, openCreate } = useNota();
  const timezone = user.timezone;
  const edit = !!initial?.id;
  const [subject, setSubject] = useState<Subject>(
    kind === 'arrangement' ? 'event' : (kind as Subject),
  );
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [allDay, setAllDay] = useState(!!initial?.all_day || !!initial?.starts_on);
  const [plannedTimed, setPlannedTimed] = useState(!!initial?.planned_at);
  const [plannedText, setPlannedText] = useState(
    initial?.planned_at
      ? localInput(initial.planned_at, timezone)
      : (initial?.planned_date ?? (!edit ? initial?.starts_on : '') ?? ''),
  );
  const [dueTimed, setDueTimed] = useState(!!initial?.due_at);
  const [dueText, setDueText] = useState(
    initial?.due_at ? localInput(initial.due_at, timezone) : (initial?.due_date ?? ''),
  );
  const [eventEnd, setEventEnd] = useState(
    initial?.ends_at && !initial?.all_day ? localInput(initial.ends_at, timezone) : '',
  );
  const [cancelled, setCancelled] = useState<string[]>([]);
  const [reminderParent, setReminderParent] = useState<any>(initial?.parent_item);
  React.useEffect(() => {
    if (subject !== 'reminder' || reminderParent || (!initial?.event_id && !initial?.todo_id))
      return;
    let alive = true;
    api(initial.event_id ? `/calendar/${initial.event_id}` : `/todos/${initial.todo_id}`)
      .then((value) => {
        if (alive) setReminderParent(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [subject, initial?.event_id, initial?.todo_id, reminderParent]);
  const anchors =
    subject === 'event'
      ? allDay
        ? []
        : ['start', ...(eventEnd ? ['end'] : [])]
      : subject === 'todo'
        ? [
            ...(plannedTimed && plannedText ? ['planned'] : []),
            ...(dueTimed && dueText ? ['due'] : []),
          ]
        : initial?.event_id
          ? reminderParent?.all_day
            ? []
            : ['start', ...(reminderParent?.ends_at ? ['end'] : [])]
          : initial?.todo_id
            ? [
                ...(reminderParent?.planned_at ? ['planned'] : []),
                ...(reminderParent?.due_at ? ['due'] : []),
              ]
            : [];
  const title =
    kind === 'arrangement'
      ? '新建事项'
      : `${edit ? '编辑' : '新建'}${subject === 'event' ? '日程' : subject === 'todo' ? '待办' : initial?.event_id || initial?.todo_id ? '提醒' : '独立提醒'}`;
  const start =
    initial?.starts_at && !initial?.all_day ? localInput(initial.starts_at, timezone) : '';
  const initialDate =
    initial?.starts_on ?? initial?.planned_date ?? localInput(new Date(), timezone).slice(0, 10);
  const reminders: CalendarReminder[] = initial?.reminders ?? [];

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="modal-form agenda-editor"
        onSubmit={async (e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          const str = (key: string) => String(values[key] ?? '');
          setBusy(true);
          const result = await action(async () => {
            const at = (key: string) => (str(key) ? zonedISO(str(key), timezone) : null);
            const setting = reminderInput(values);
            const alerts = setting
              ? [
                  {
                    ...setting,
                    ...(setting.remind_at
                      ? { remind_at: zonedISO(setting.remind_at, timezone) }
                      : {}),
                  },
                ]
              : [];
            const body: any = { title: str('title'), timezone, notes: str('notes') };
            if (subject === 'event') {
              Object.assign(
                body,
                { all_day: allDay, location: str('location') },
                allDay
                  ? {
                      starts_on: str('starts_on'),
                      ends_on: addCalendarDays(str('ends_on') || str('starts_on'), 1),
                    }
                  : {
                      starts_at: at('starts_at'),
                      ends_at: at('ends_at'),
                      starts_on: null,
                      ends_on: null,
                    },
              );
            } else if (subject === 'todo')
              Object.assign(body, {
                planned_date: plannedTimed ? null : str('planned_date') || null,
                planned_at: plannedTimed ? at('planned_at') : null,
                planned_end_at: plannedTimed ? at('planned_end_at') : null,
                due_date: dueTimed ? null : str('due_date') || null,
                due_at: dueTimed ? at('due_at') : null,
              });
            if (subject === 'reminder') {
              const reminder = { title: body.title, ...alerts[0] };
              return edit
                ? patch(`/reminders/${initial.id}`, reminder)
                : post('/reminders', {
                    ...reminder,
                    ...(initial?.event_id ? { event_id: initial.event_id } : {}),
                    ...(initial?.todo_id ? { todo_id: initial.todo_id } : {}),
                  });
            }
            if (edit)
              return patch(
                subject === 'event' ? `/calendar/${initial.id}` : `/todos/${initial.id}`,
                { ...body, ...(alerts.length ? { add_reminders: alerts } : {}) },
              );
            return post('/arrangements', { ...body, kind: subject, reminders: alerts });
          }, '已保存');
          setBusy(false);
          if (result) {
            initial?.onSaved?.(
              str('starts_on') ||
                str('starts_at') ||
                str('planned_date') ||
                str('planned_at') ||
                str('due_date') ||
                str('due_at') ||
                str('remind_at'),
            );
            onClose();
          }
        }}
      >
        {!edit && !initial?.event_id && !initial?.todo_id && (
          <div className="agenda-type-switch" role="group" aria-label="事项类型">
            {choices.map(([value, label]) => (
              <button
                type="button"
                aria-pressed={subject === value}
                key={value}
                onClick={() => setSubject(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="field-hint agenda-type-explainer">
          {subject === 'event'
            ? '约定发生的安排，例如聚餐、会议、已预约的看牙。'
            : subject === 'todo'
              ? '需要完成的行动，可分别设置计划日期和截止日期。'
              : initial?.event_id || initial?.todo_id
                ? '通知设置属于原事项，不会新增一件日程或待办。'
                : '只在指定时间通知你，例如叫醒或临时提示。'}
        </p>
        <Field label="标题">
          <input name="title" required maxLength={300} defaultValue={initial?.title ?? ''} />
        </Field>
        {subject === 'event' && (
          <>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              <span>全天 / 仅日期</span>
            </label>
            {allDay ? (
              <div className="form-row">
                <Field label="开始日期">
                  <input type="date" name="starts_on" required defaultValue={initialDate} />
                </Field>
                <Field label="结束日期（含当日，可选）">
                  <input
                    type="date"
                    name="ends_on"
                    defaultValue={initial?.ends_on ? addCalendarDays(initial.ends_on, -1) : ''}
                  />
                </Field>
              </div>
            ) : (
              <div className="form-row">
                <Field label="开始时间">
                  <input type="datetime-local" name="starts_at" required defaultValue={start} />
                </Field>
                <Field label="结束时间（可选）">
                  <input
                    type="datetime-local"
                    name="ends_at"
                    value={eventEnd}
                    onChange={(e) => setEventEnd(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Field label="地点（可选）">
              <input name="location" maxLength={400} defaultValue={initial?.location ?? ''} />
            </Field>
          </>
        )}
        {subject === 'todo' && (
          <>
            <PrecisionField
              key="planned"
              label="计划日期"
              prefix="planned"
              timezone={timezone}
              value={{
                date: initial?.planned_date ?? (!edit ? initial?.starts_on : undefined),
                at: initial?.planned_at,
              }}
              onChange={(timed, text) => {
                setPlannedTimed(timed);
                setPlannedText(text);
              }}
            />
            {plannedTimed && (
              <Field label="计划结束时间（可选）">
                <input
                  type="datetime-local"
                  name="planned_end_at"
                  defaultValue={
                    initial?.planned_end_at ? localInput(initial.planned_end_at, timezone) : ''
                  }
                />
              </Field>
            )}
            <PrecisionField
              key="due"
              label="截止日期"
              prefix="due"
              timezone={timezone}
              value={{ date: initial?.due_date, at: initial?.due_at }}
              onChange={(timed, text) => {
                setDueTimed(timed);
                setDueText(text);
              }}
            />
          </>
        )}
        {subject !== 'reminder' && (
          <Field label="备注">
            <textarea name="notes" rows={3} maxLength={3000} defaultValue={initial?.notes ?? ''} />
          </Field>
        )}
        {subject !== 'reminder' && reminders.length > 0 && (
          <div className="agenda-existing-reminders">
            <h3>
              <Bell size={15} /> 已有提醒
            </h3>
            {reminders.map((r) => {
              const status = cancelled.includes(r.id) ? 'cancelled' : r.status;
              return (
                <div className="agenda-existing-reminder" key={r.id}>
                  <div>
                    <strong>{formatDate(r.remind_at, timezone)}</strong>
                    <small>
                      {status === 'scheduled'
                        ? r.trigger_kind === 'relative'
                          ? '随事项改期'
                          : '固定时刻'
                        : status === 'delivered'
                          ? '已通知'
                          : '已取消'}
                    </small>
                  </div>
                  {status === 'scheduled' && (
                    <div>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => openCreate('reminder', { ...r, parent_item: initial })}
                      >
                        修改
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`取消提醒 ${r.title}`}
                        onClick={async () => {
                          const r0 = await action(() => remove(`/reminders/${r.id}`), '提醒已取消');
                          if (r0) setCancelled((ids) => [...ids, r.id]);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <ReminderFields
          key={`${subject}-${allDay}-${anchors.join(',')}`}
          initial={subject === 'reminder' ? { ...initial, timezone } : undefined}
          anchors={anchors}
          standalone={subject === 'reminder' && !initial?.event_id && !initial?.todo_id}
        />
        {subject === 'todo' && edit && (
          <p className="field-hint">
            完成待办会取消未来提醒。恢复待办后，可按需重新设置提醒；清除基准时刻会取消对应的相对提醒。
          </p>
        )}
        <p className="field-hint">时区：{timezone}</p>
        <footer className="modal-actions">
          {edit && subject === 'event' && (
            <Button type="button" variant="danger" onClick={() => setConfirm(true)}>
              取消日程
            </Button>
          )}
          {edit && subject === 'todo' && (
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                const result = await action(
                  () =>
                    patch(`/todos/${initial.id}`, {
                      status: initial.status === 'done' ? 'open' : 'done',
                    }),
                  initial.status === 'done' ? '已恢复待办' : '已完成待办，未来提醒已取消',
                );
                if (result) onClose();
              }}
            >
              <Check size={15} />
              {initial.status === 'done' ? '恢复待办' : '完成待办'}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            返回
          </Button>
          <Button type="submit" busy={busy}>
            保存
          </Button>
        </footer>
      </form>
      {confirm && (
        <Confirm
          title="取消这个日程？"
          body="未来提醒也会取消，历史记录保留。"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const result = await action(
              () => patch(`/calendar/${initial.id}`, { status: 'cancelled' }),
              '日程及未来提醒已取消',
            );
            if (result) onClose();
          }}
        />
      )}
    </Modal>
  );
}
