/** Calendar dates stay as YYYY-MM-DD; only explicitly timed values become instants. */
export function localInput(value: string | Date, timezone: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replace(' ', 'T');
}

export function zonedISO(value: string, timezone: string) {
  if (!value) throw new Error('请选择日期和时间');
  const [y, m, d, h, min] = value.split(/[-T:]/).map(Number);
  const target = Date.UTC(y, m - 1, d, h, min);
  let guess = target;
  const read = (ms: number) => {
    const p = localInput(new Date(ms), timezone).split(/[-T:]/).map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]);
  };
  for (let i = 0; i < 3; i++) guess += target - read(guess);
  if (read(guess) !== target) throw new Error('该本地时间不存在，请检查夏令时');
  return new Date(guess).toISOString();
}

export function addCalendarDays(value: string, days: number) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}

export function dateLabel(value: string) {
  return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}
