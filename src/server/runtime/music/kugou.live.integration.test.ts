// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { KugouMusicProvider } from './kugou-provider';

/** Opt-in upstream verification, independent of account cookies or paid entitlements. */
it.skipIf(process.env.KUGOU_LIVE !== '1')(
  'plays the granted real Kugou preview and loads its album artwork',
  async () => {
    const provider = new KugouMusicProvider('live-catalog-validation');
    const tracks = await provider.search('周杰伦 晴天', 3);
    expect(tracks.length).toBeGreaterThan(0);
    const track = tracks.find((item) => item.coverUrl && item.playbackKind === 'preview')!;
    expect(track).toBeDefined();
    const resolved = await provider.resolve(track.id);
    const stream = await provider.stream(
      track.id,
      new Request('https://app.test', { headers: { Range: 'bytes=0-4095' } }),
    );
    expect(stream.status).toBe(206);
    const bytes = await stream.arrayBuffer();
    expect(bytes.byteLength).toBe(4096);
    const cover = await provider.cover(track.id, new Request('https://app.test'));
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toMatch(/^image\/(jpeg|png|webp)$/u);
    const artwork = await cover.arrayBuffer();
    expect(artwork.byteLength).toBeGreaterThan(1000);
    await mkdir('.data/kugou-validation', { recursive: true });
    await writeFile(
      '.data/kugou-validation/provider-live.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          track: resolved.track,
          mediaStatus: stream.status,
          contentRange: stream.headers.get('content-range'),
          mediaBytes: bytes.byteLength,
          coverType: cover.headers.get('content-type'),
          coverBytes: artwork.byteLength,
        },
        null,
        2,
      ),
    );
  },
  45_000,
);
