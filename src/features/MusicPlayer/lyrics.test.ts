import { describe, expect, it } from 'vitest';

import {
  activeLyric,
  activeLyricWord,
  formatTime,
  lyricWordProgress,
  MAX_LRC_BYTES,
  parseKrc,
  parseLrc,
} from './lyrics';

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

describe('real KRC word timing', () => {
  it('preserves supplied groups, spaces, duration and global offset without inventing timing', () => {
    const lines = parseKrc('[ar:Artist]\n[offset:100]\n[1000,2000]<0,500,0>Hello <800,1200,0>世界');
    expect(lines).toEqual([
      {
        durationMs: 2000,
        text: 'Hello 世界',
        timeMs: 1100,
        words: [
          { durationMs: 500, text: 'Hello ', timeMs: 1100 },
          { durationMs: 1200, text: '世界', timeMs: 1900 },
        ],
      },
    ]);
    expect(parseLrc('[00:01]Hello 世界')[0].words).toBeUndefined();
  });
  it('locates exact word boundaries, gaps, reverse seeks and progressive fill', () => {
    const words = parseKrc('[1000,2000]<0,500,0>First<800,1200,0>second')[0].words!;
    expect(
      [0, 1000, 1250, 1500, 1800, 2999, 3000, 1100].map((position) =>
        activeLyricWord(words, position),
      ),
    ).toEqual([-1, 0, 0, -1, 1, 1, -1, 0]);
    expect(
      [999, 1000, 1250, 1500].map((position) => lyricWordProgress(words[0], position)),
    ).toEqual([0, 0, 0.5, 1]);
  });
  it('keeps a real word spanning time zero and treats markup only as text', () => {
    const line = parseKrc('[offset:-250]\n[0,1000]<0,1000,0><img src=x onerror=alert(1)>')[0];
    expect(line.timeMs).toBe(0);
    expect(line.words?.[0].timeMs).toBe(-250);
    expect(line.words?.[0].text).toBe('<img src=x onerror=alert(1)>');
    expect(lyricWordProgress(line.words![0], 0)).toBe(0.25);
  });
  it.each([
    '[0,100]<0,101,0>overflow',
    '[0,100]<50,10,0>one<10,10,0>backward',
    '[0,100]<-1,10,0>negative',
    '[99999999,1]<0,1,0>too late',
    '[offset:999999999999999999999]\n[0,100]<0,100,0>bad offset',
  ])('rejects invalid source timing: %s', (text) => {
    expect(() => parseKrc(text)).toThrow('KRC_INVALID');
  });
});
