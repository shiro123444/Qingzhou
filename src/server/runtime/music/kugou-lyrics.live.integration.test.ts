// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { KugouLyricsSource } from './kugou-lyrics';

it.skipIf(process.env.KUGOU_LIVE !== '1')(
  'loads real word-timed KRC without browser-supplied download keys',
  async () => {
    const result = await new KugouLyricsSource().get(
      'kugou:b3a52a7a958bf0aed0ebfba2e9a818b7:966846:32100650',
    );
    expect(result.format).toBe('krc');
    expect(result.text).toMatch(/\[\d+,\d+\]<\d+,\d+,\d+>/u);
    expect(result.text!.split('\n').length).toBeGreaterThan(10);
    const words = [...result.text!.matchAll(/<(\d+),(\d+),\d+>/gu)];
    expect(words.length).toBeGreaterThan(100);
    expect(new Set(words.map((word) => word[2])).size).toBeGreaterThan(10);
    await mkdir('.data/kugou-validation', { recursive: true });
    // Preserve proof of source/shape, not a copy of the song's copyrighted lyrics.
    await writeFile(
      '.data/kugou-validation/lyrics-live.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          trackId: result.trackId,
          format: result.format,
          bytes: Buffer.byteLength(result.text!),
          lines: result.text!.split('\n').length,
          words: words.length,
          distinctWordDurations: new Set(words.map((word) => word[2])).size,
        },
        null,
        2,
      ),
    );
  },
  30_000,
);
