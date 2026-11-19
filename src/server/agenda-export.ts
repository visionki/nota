/** Export the same calendar subjects as the UI, with alerts nested in their owner. */
export function ics(events: any[], todos: any[] = [], reminders: any[] = []) {
  const esc = (value: string) =>
    value
      .replaceAll('\\', '\\\\')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replaceAll(',', '\\,')
      .replaceAll(';', '\\;');
  const dt = (value: string | Date) =>
    new Date(value)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const day = (value: string) => value.replaceAll('-', '');
  const stamp = `DTSTAMP:${dt(new Date())}`;
  const alarms = (owner: any, kind: 'event' | 'todo' | 'reminder') =>
    reminders
      .filter(
        (r) =>
          r.status === 'scheduled' &&
          (kind === 'reminder' ? r.id === owner.id : r[`${kind}_id`] === owner.id),
      )
      .flatMap((r) => [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${esc(r.title)}`,
        r.trigger_kind === 'relative' &&
        (kind === 'event' ||
          (r.relative_to === 'planned' && owner.planned_at && !owner.due_date) ||
          (r.relative_to === 'due' && owner.due_at))
          ? `TRIGGER;RELATED=${['end', 'due'].includes(r.relative_to) ? 'END' : 'START'}:${r.before_minutes > 0 ? '-' : ''}PT${Math.abs(r.before_minutes)}M`
          : `TRIGGER;VALUE=DATE-TIME:${dt(r.remind_at)}`,
        'END:VALARM',
      ]);
  const fields = (value: any) => [
    `SUMMARY:${esc(value.title)}`,
    `DESCRIPTION:${esc(value.notes ?? '')}`,
  ];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nota//Calendar//ZH',
    'CALSCALE:GREGORIAN',
  ];
  for (const event of events.filter((e) => e.status !== 'cancelled')) {
    lines.push('BEGIN:VEVENT', `UID:${event.id}@nota`, stamp);
    if (event.all_day)
      lines.push(
        `DTSTART;VALUE=DATE:${day(event.starts_on)}`,
        `DTEND;VALUE=DATE:${day(event.ends_on)}`,
      );
    else {
      lines.push(`DTSTART:${dt(event.starts_at)}`);
      if (event.ends_at) lines.push(`DTEND:${dt(event.ends_at)}`);
    }
    lines.push(
      ...fields(event),
      `LOCATION:${esc(event.location ?? '')}`,
      ...alarms(event, 'event'),
      'END:VEVENT',
    );
  }
  for (const todo of todos) {
    lines.push(
      'BEGIN:VTODO',
      `UID:${todo.id}@nota`,
      stamp,
      ...fields(todo),
      `STATUS:${todo.status === 'done' ? 'COMPLETED' : 'NEEDS-ACTION'}`,
    );
    const mixed = (!!todo.planned_date && !!todo.due_at) || (!!todo.planned_at && !!todo.due_date);
    if (todo.planned_date)
      lines.push(
        `${mixed ? 'X-NOTA-PLANNED-DATE:' : 'DTSTART;VALUE=DATE:'}${day(todo.planned_date)}`,
      );
    else if (todo.planned_at)
      lines.push(`${mixed ? 'X-NOTA-PLANNED-AT:' : 'DTSTART:'}${dt(todo.planned_at)}`);
    if (todo.due_date) lines.push(`DUE;VALUE=DATE:${day(todo.due_date)}`);
    else if (todo.due_at) lines.push(`DUE:${dt(todo.due_at)}`);
    // RFC 5545 requires matching DTSTART/DUE value types. Preserve a mixed-precision plan
    // as metadata rather than inventing a time or degrading the real deadline.
    if (todo.planned_end_at) lines.push(`X-NOTA-PLANNED-END:${dt(todo.planned_end_at)}`);
    if (todo.status !== 'done') lines.push(...alarms(todo, 'todo'));
    lines.push('END:VTODO');
  }
  for (const reminder of reminders.filter(
    (r) => !r.event_id && !r.todo_id && r.status === 'scheduled',
  )) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:reminder-${reminder.id}@nota`,
      stamp,
      `DTSTART:${dt(reminder.remind_at)}`,
      `SUMMARY:${esc(reminder.title)}`,
      'X-NOTA-KIND:REMINDER',
      ...alarms(reminder, 'reminder'),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR', '');
  return lines
    .map((line) => {
      let folded = '',
        column = 0;
      for (const char of line) {
        const size = Buffer.byteLength(char);
        if (column + size > 75) {
          folded += '\r\n ';
          column = 1;
        }
        folded += char;
        column += size;
      }
      return folded;
    })
    .join('\r\n');
}
