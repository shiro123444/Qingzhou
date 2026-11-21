/** Five-field cron with lists, ranges, steps, names, POSIX day matching and IANA timezones. */
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function field(source: string, min: number, max: number, names?: string[]) {
  const values = new Set<number>();
  const number = (text: string) => {
    const index = names?.indexOf(text.toUpperCase()) ?? -1;
    const value = index >= 0 ? index + min : /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error('Invalid cron value');
    return value;
  };
  for (const part of source.split(',')) {
    const [range, stepText, extra] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (extra || !Number.isInteger(step) || step < 1 || step > max - min + 1)
      throw new Error('Invalid cron step');
    const pair = range.split('-');
    const start = range === '*' ? min : number(pair[0]);
    const end =
      range === '*' || (stepText && pair.length === 1)
        ? max
        : pair.length === 2
          ? number(pair[1])
          : start;
    if (pair.length > 2 || end < start) throw new Error('Invalid cron range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard: source.startsWith('*') };
}
export function latestCronSlot(
  pattern: string,
  timezone: string | null,
  after: Date,
  until: Date,
): Date | null {
  if (pattern.length > 256) throw new Error('Invalid cron length');
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Expected a five-field cron');
  const [minute, hour, day, month, weekday] = [
    field(parts[0], 0, 59),
    field(parts[1], 0, 23),
    field(parts[2], 1, 31),
    field(parts[3], 1, 12, months),
    field(parts[4], 0, 7, weekdays),
  ];
  if (weekday.values.has(7)) weekday.values.add(0);
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const first = Math.max(after.getTime(), until.getTime() - 86_400_000);
  for (let time = Math.floor(until.getTime() / 60_000) * 60_000; time > first; time -= 60_000) {
    const local = Object.fromEntries(
      format.formatToParts(time).map((part) => [part.type, part.value]),
    );
    const dayMatch = day.values.has(Number(local.day));
    const weekMatch = weekday.values.has(weekdays.indexOf(local.weekday.toUpperCase()));
    const matchesDay = day.wildcard
      ? weekMatch
      : weekday.wildcard
        ? dayMatch
        : dayMatch || weekMatch;
    if (
      minute.values.has(Number(local.minute)) &&
      hour.values.has(Number(local.hour)) &&
      month.values.has(Number(local.month)) &&
      matchesDay
    )
      return new Date(time);
  }
  return null;
}
