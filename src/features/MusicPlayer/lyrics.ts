export const MAX_LRC_BYTES = 128 * 1024;
const MAX_LYRIC_TIME = 24 * 60 * 60_000;

export interface LyricWord {
  durationMs: number;
  text: string;
  timeMs: number;
}

export interface LyricLine {
  durationMs?: number;
  text: string;
  timeMs: number;
  words?: readonly Readonly<LyricWord>[];
}

export function freezeLyricLines(lines: readonly Readonly<LyricLine>[]) {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze({
        text: line.text,
        timeMs: line.timeMs,
        ...(line.durationMs === undefined ? {} : { durationMs: line.durationMs }),
        ...(line.words
          ? {
              words: Object.freeze(
                line.words.map((word) =>
                  Object.freeze({
                    text: word.text,
                    timeMs: word.timeMs,
                    durationMs: word.durationMs,
                  }),
                ),
              ),
            }
          : {}),
      }),
    ),
  );
}

/** KRC timestamps describe original word groups; LRC never invents word timing. */
export function parseKrc(text: string): LyricLine[] {
  if (new TextEncoder().encode(text).length > MAX_LRC_BYTES) throw new Error('KRC_LIMIT');
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/iu)?.[1] ?? 0);
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > MAX_LYRIC_TIME)
    throw new Error('KRC_INVALID');
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const stamp = /^\[(\d{1,8}),(\d{1,8})\](.*)$/u.exec(raw);
    if (!stamp) {
      if (/^\[\d/u.test(raw)) throw new Error('KRC_INVALID');
      continue;
    }
    const start = Number(stamp[1]);
    const duration = Number(stamp[2]);
    if (start + duration > MAX_LYRIC_TIME) throw new Error('KRC_INVALID');
    const body = stamp[3];
    const tokens = [...body.matchAll(/<(\d{1,8}),(\d{1,8}),(\d{1,3})>/gu)];
    if (!tokens.length || tokens[0].index !== 0) throw new Error('KRC_INVALID');
    const words: LyricWord[] = [];
    let previous = -1;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const relative = Number(token[1]);
      const wordDuration = Number(token[2]);
      if (relative < previous || relative + wordDuration > duration) throw new Error('KRC_INVALID');
      previous = relative;
      const wordText = body.slice(token.index + token[0].length, tokens[index + 1]?.index);
      if (/<[\d,+-]+>/u.test(wordText)) throw new Error('KRC_INVALID');
      words.push({ durationMs: wordDuration, text: wordText, timeMs: start + relative + offset });
    }
    const content = words.map((word) => word.text).join('');
    if (content.length > 1000 || words.length > 1000) throw new Error('KRC_LIMIT');
    if (start + duration + offset < 0) continue;
    lines.push({
      durationMs: Math.max(0, start + duration + offset) - Math.max(0, start + offset),
      text: content,
      timeMs: Math.max(0, start + offset),
      words,
    });
    if (lines.length > 4000) throw new Error('KRC_LIMIT');
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function lyricWordProgress(word: Readonly<LyricWord>, positionMs: number): number {
  if (positionMs < word.timeMs) return 0;
  return word.durationMs > 0
    ? Math.max(0, Math.min(1, (positionMs - word.timeMs) / word.durationMs))
    : 1;
}

export function activeLyricWord(words: readonly Readonly<LyricWord>[], positionMs: number): number {
  const index = activeLyric(words, positionMs);
  return index >= 0 && positionMs < words[index].timeMs + words[index].durationMs ? index : -1;
}

/** Plain text only: never render lyrics as HTML. Offset applies to every timestamp. */
export function parseLrc(text: string): LyricLine[] {
  if (new TextEncoder().encode(text).length > MAX_LRC_BYTES) throw new Error('LRC_LIMIT');
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0);
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const content = raw
      .replaceAll(/\[[^\]]*\]/g, '')
      .trim()
      .slice(0, 1000);
    for (const stamp of stamps) {
      const fraction = Number(`0.${stamp[3] ?? '0'}`) * 1000;
      const timeMs = Math.max(
        0,
        Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + fraction + offset,
      );
      if (timeMs <= 24 * 60 * 60_000) lines.push({ text: content, timeMs });
      if (lines.length > 4000) throw new Error('LRC_LIMIT');
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function activeLyric(lines: readonly Readonly<LyricLine>[], positionMs: number): number {
  let left = 0;
  let right = lines.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (lines[middle].timeMs <= positionMs) left = middle + 1;
    else right = middle;
  }
  return left - 1;
}

export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
