import { describe, expect, it } from 'vitest';

import { activeLyric, formatTime, MAX_LRC_BYTES, parseLrc } from './lyrics';

describe('LRC synchronization', () => {
  it('handles metadata, multiple tags, fractions, global offsets and stable sorting', () => {
    expect(
      parseLrc('[ar:Artist]\n[00:03.5][00:01.05]same\n[00:00.010]first\n[offset:-100]'),
    ).toEqual([
      { text: 'first', timeMs: 0 },
      { text: 'same', timeMs: 950 },
      { text: 'same', timeMs: 3400 },
    ]);
  });
  it('keeps untrusted content as text and ignores malformed stamps', () => {
    expect(parseLrc('[00:xx]bad\n[00:70]bad\n[00:01]<img src=x onerror=alert(1)>')[0]).toEqual({
      text: '<img src=x onerror=alert(1)>',
      timeMs: 1000,
    });
  });
  it('finds the line before/at/after boundaries, including repeated timestamps and reverse seek', () => {
    const lines = parseLrc('[00:01]a\n[00:02]b\n[00:02]c\n[00:05]d');
    expect([0, 1000, 2500, 9000, 1500].map((ms) => activeLyric(lines, ms))).toEqual([
      -1, 0, 2, 3, 0,
    ]);
    expect(activeLyric([], 1000)).toBe(-1);
    expect(formatTime(125_100)).toBe('2:05');
  });
  it('bounds input bytes and parsed lines', () => {
    expect(() => parseLrc('中'.repeat(MAX_LRC_BYTES / 2))).toThrow('LRC_LIMIT');
    expect(() => parseLrc('[00:01]a\n'.repeat(4001))).toThrow('LRC_LIMIT');
  });
});
