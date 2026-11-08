// @vitest-environment node
import { deflateSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { KugouLyricsSource } from './kugou-lyrics';

const id = `kugou:${'a'.repeat(32)}:11:22`;
const search = () =>
  Response.json({ status: 200, candidates: [{ id: '7', accesskey: 'upstream-only' }] });
const lrc = '[00:01.00]Test line\n[00:03.25]Second line';
const krc = '[offset:0]\n[1000,2000]<0,500,0>Test <500,1500,0>line\n[3250,1000]<0,1000,0>Second';
function encodeKrc(text: string | Uint8Array) {
  const compressed = deflateSync(text);
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  for (let index = 0; index < compressed.length; index++) compressed[index] ^= key[index % 16];
  return Buffer.concat([Buffer.from('krc1'), compressed]).toString('base64');
}
const fixture = () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(search())
    .mockResolvedValueOnce(Response.json({ status: 200, contenttype: 0, content: encodeKrc(krc) }));
  return { fetcher, source: new KugouLyricsSource(fetcher) };
};

describe('Kugou automatic timed lyrics', () => {
  it('uses only the exact hash, keeps upstream keys private, and caches completed lyrics', async () => {
    const { source, fetcher } = fixture();
    const result = await source.get(id);
    expect(result).toEqual({ trackId: id, format: 'krc', text: krc });
    const requested = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(requested.map((url) => url.origin)).toEqual([
      'https://lyrics.kugou.com',
      'https://lyrics.kugou.com',
    ]);
    expect(requested[0].searchParams.get('hash')).toBe('a'.repeat(32));
    expect(requested[0].searchParams.get('keyword')).toBe('');
    expect(requested[0].searchParams.has('signature')).toBe(true);
    expect(requested[1].searchParams.get('fmt')).toBe('krc');
    expect(JSON.stringify(result)).not.toContain('upstream-only');
    expect(await source.get(id)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('accepts an upstream LRC response to a KRC request without manufacturing word timings', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(search())
      .mockResolvedValueOnce(
        Response.json({
          status: 200,
          contenttype: 1,
          content: Buffer.from(lrc).toString('base64'),
        }),
      );
    expect(await new KugouLyricsSource(fetcher).get(id)).toEqual({
      trackId: id,
      format: 'lrc',
      text: lrc,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ status: 404 }, { status: 200, content: '' }])(
    'requests LRC only when KRC is absent (%j)',
    async (missing) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(search())
        .mockResolvedValueOnce(Response.json(missing))
        .mockResolvedValueOnce(
          Response.json({ status: 200, content: Buffer.from(lrc).toString('base64') }),
        );
      expect(await new KugouLyricsSource(fetcher).get(id)).toEqual({
        trackId: id,
        format: 'lrc',
        text: lrc,
      });
      expect(
        fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('fmt')),
      ).toEqual(['krc', 'lrc']);
    },
  );
  it('rejects broken KRC, compressed bombs, invalid UTF-8 and invalid timing without a silent fallback', async () => {
    const invalid = [
      Buffer.from('krc1broken').toString('base64'),
      Buffer.from('not-krc').toString('base64'),
      encodeKrc('[0,1]<0,1,0>' + 'x'.repeat(128 * 1024)),
      encodeKrc(new Uint8Array([255, 255])),
      encodeKrc('[1000,2000]<0,1000,0>A<500,2000,0>B'),
      encodeKrc('[1000,2000]<1000,500,0>A<0,500,0>B'),
      encodeKrc('[1000,1000]<-1,100,0>A'),
      encodeKrc('[99999999999999999999,1000]<0,1,0>A'),
      encodeKrc('[offset:99999999999999999999]\n[0,1000]<0,1,0>A'),
      encodeKrc('[1000,1000]<0,1,0>A\n[0,1000]<0,1,0>B'),
      '####',
    ];
    for (const content of invalid) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(search())
        .mockResolvedValueOnce(Response.json({ status: 200, contenttype: 0, content }));
      await expect(new KugouLyricsSource(fetcher).get(id)).rejects.toMatchObject({
        code: 'MUSIC_LYRICS_UNAVAILABLE',
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('does not fall back after an upstream verification or permission refusal', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(search())
      .mockResolvedValueOnce(Response.json({ status: 403 }));
    await expect(new KugouLyricsSource(fetcher).get(id)).rejects.toMatchObject({
      code: 'MUSIC_LYRICS_UNAVAILABLE',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('treats a missing timed lyric as empty without substituting another recording', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: 200, candidates: [] }));
    expect(await new KugouLyricsSource(fetcher).get(id)).toEqual({
      trackId: id,
      format: 'lrc',
      text: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects unbounded chunked responses and malformed IDs before another request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1)));
    const source = new KugouLyricsSource(fetcher);
    await expect(source.get('https://private.test/')).rejects.toMatchObject({
      code: 'MUSIC_TRACK_UNAVAILABLE',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(source.get(id)).rejects.toMatchObject({ code: 'MUSIC_LYRICS_UNAVAILABLE' });
  });
  it('does not return a cached or late result to a canceled request', async () => {
    const { source } = fixture();
    await source.get(id);
    const abort = new AbortController();
    abort.abort();
    await expect(source.get(id, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    let finish!: (value: Response) => void;
    const late = new KugouLyricsSource(
      vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const pending = late.get(id, controller.signal);
    controller.abort();
    finish(Response.json({ status: 200, candidates: [] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects upstream challenges, invalid UTF-8, oversized decoded lyrics and hidden URL errors', async () => {
    const challenged = new KugouLyricsSource(
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { headers: { 'ssa-code': '1' } })),
    );
    await expect(challenged.get(id)).rejects.toMatchObject({ code: 'MUSIC_LYRICS_UNAVAILABLE' });
    for (const bytes of [Buffer.from([255, 255]), Buffer.from('a'.repeat(128 * 1024 + 1))]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(search())
        .mockResolvedValueOnce(Response.json({ status: 200, content: bytes.toString('base64') }));
      await expect(new KugouLyricsSource(fetcher).get(id)).rejects.toMatchObject({
        code: 'MUSIC_LYRICS_UNAVAILABLE',
      });
    }
    const failed = new KugouLyricsSource(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private accesskey=secret')),
    );
    await expect(failed.get(id)).rejects.toThrow('MUSIC_LYRICS_UNAVAILABLE');
  });
});
