// @vitest-environment node
import { expect, it } from 'vitest';

import { latestCronSlot } from './cron';

const due = (pattern: string, after: string, until: string, zone = 'UTC') =>
  latestCronSlot(pattern, zone, new Date(after), new Date(until))?.toISOString() ?? null;
it('honors the minute, month and weekday without firing early', () => {
  expect(due('30 8 * NOV MON-FRI', '2026-11-10T08:29:00Z', '2026-11-10T08:29:59Z')).toBeNull();
  expect(due('30 8 * NOV MON-FRI', '2026-11-10T08:29:00Z', '2026-11-10T08:30:01Z')).toBe(
    '2026-11-10T08:30:00.000Z',
  );
  expect(due('30 8 * DEC *', '2026-11-10T08:29:00Z', '2026-11-10T08:30:01Z')).toBeNull();
});
it('supports lists, steps, timezone offsets and coalesces missed slots', () => {
  expect(due('0,15,30,45 */2 * * *', '2026-11-10T00:00:01Z', '2026-11-10T04:37:00Z')).toBe(
    '2026-11-10T04:30:00.000Z',
  );
  expect(due('30 8 * * *', '2026-11-09T23:00:00Z', '2026-11-10T00:31:00Z', 'Asia/Shanghai')).toBe(
    '2026-11-10T00:30:00.000Z',
  );
});
it('distinguishes the two UTC occurrences when daylight saving time repeats an hour', () => {
  expect(
    due('30 1 * * *', '2026-11-01T05:29:00Z', '2026-11-01T05:31:00Z', 'America/New_York'),
  ).toBe('2026-11-01T05:30:00.000Z');
  expect(
    due('30 1 * * *', '2026-11-01T06:29:00Z', '2026-11-01T06:31:00Z', 'America/New_York'),
  ).toBe('2026-11-01T06:30:00.000Z');
});
it('uses POSIX day-of-month/weekday OR and rejects invalid schedules', () => {
  expect(due('0 8 1 * TUE', '2026-11-10T07:59:00Z', '2026-11-10T08:01:00Z')).toBe(
    '2026-11-10T08:00:00.000Z',
  );
  for (const pattern of ['*/0 * * * *', '61 * * * *', '* * *', '* * * * BAD'])
    expect(() => due(pattern, '2026-11-10T07:59:00Z', '2026-11-10T08:00:00Z')).toThrow();
});
