export const MAX_LRC_BYTES = 128 * 1024;

export interface LyricLine {
  text: string;
  timeMs: number;
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

export function activeLyric(lines: LyricLine[], positionMs: number): number {
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
