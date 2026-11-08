// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { musicTrackSchema } from '@/types/music';

import { CatalogMusicProvider } from './catalog-provider';
import { type MusicProvider } from './contracts';
import { kugouAssetUrl, KugouMusicProvider, kugouTrackId } from './kugou-provider';

const hash = 'a'.repeat(32);
const id = kugouTrackId(hash, 12, 34);
const song = {
  AlbumID: '12',
  AlbumName: 'Album',
  Duration: 240,
  FileHash: hash,
  FileName: 'Artist - Song',
  FileSize: 4000000,
  Image: 'http://imge.kugou.com/stdmusic/{size}/cover.jpg',
  MixSongID: '34',
  Privilege: 10,
  SingerName: 'Artist',
  SongName: 'Song',
};
const playback = {
  status: 1,
  extName: 'mp3',
  hash_offset: { start_ms: 0, end_ms: 60000 },
  timeLength: 240,
  url: ['http://fsandroid.kugou.com/preview.mp3?ticket=upstream-only'],
};
function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/search/song')
      return Response.json({ status: 1, data: { lists: [song] } });
    if (url.pathname === '/v5/url') return Response.json(playback);
    if (url.pathname === '/v2/get_res_privilege/lite') {
      const hash = JSON.parse(String(init?.body)).resource[0].hash;
      return Response.json({
        status: 1,
        data: [
          {
            hash,
            name: 'Artist - Restored song',
            singername: 'Artist',
            albumname: 'Album',
            privilege: 10,
            info: { duration: 240000, filesize: 4000000, image: song.Image },
          },
        ],
      });
    }
    if (url.hostname === 'imge.kugou.com')
      return new Response(new Uint8Array([255, 216, 255]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    if (url.hostname === 'fsandroid.kugou.com')
      return new Response(init?.method === 'HEAD' ? null : new Uint8Array([73, 68, 51, 0]), {
        headers: {
          'Content-Range': 'bytes 0-3/960116',
          'Content-Length': '4',
          'Content-Type': 'audio/mpeg',
        },
        status: 206,
      });
    throw new Error('Unexpected upstream: ' + url.hostname + url.pathname);
  });
  return { fetcher, provider: new KugouMusicProvider('alice', fetcher) };
}

describe('Kugou catalog and source boundary', () => {
  it('maps real catalog fields and serves same-origin artwork without exposing upstream media URLs', async () => {
    const f = fixture();
    const [track] = await f.provider.search('Song', 3);
    expect(musicTrackSchema.parse(track)).toEqual(
      expect.objectContaining({
        id,
        name: 'Song',
        artist: 'Artist',
        album: 'Album',
        source: 'kugou',
        playbackKind: 'preview',
        durationMs: 240000,
      }),
    );
    expect(track.coverUrl).toBe(`/api/runtime/music/tracks/${encodeURIComponent(id)}/cover`);
    expect(JSON.stringify(track)).not.toContain('kugou.com');
    const search = new URL(String(f.fetcher.mock.calls[0][0]));
    expect(search.searchParams.get('keyword')).toBe('Song');
    expect(search.searchParams.get('signature')).toMatch(/^[a-f\d]{32}$/u);
    const result = await f.provider.resolve(id);
    expect(result.track.durationMs).toBe(60000);
    expect(result.track.playbackKind).toBe('preview');
    expect(result.src).toBe(`/api/runtime/music/tracks/${encodeURIComponent(id)}/stream`);
    const request = new URL(String(f.fetcher.mock.calls[1][0]));
    expect(request.searchParams.get('IsFreePart')).toBe('1');
    expect(request.searchParams.has('token')).toBe(false);
    const cover = await f.provider.cover(id, new Request('https://app.test'));
    expect(cover.headers.get('content-type')).toBe('image/jpeg');
    expect((await cover.arrayBuffer()).byteLength).toBe(3);
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe('https://imge.kugou.com/stdmusic/480/cover.jpg');
  });

  it('streams a granted preview with Range and HEAD without buffering or exposing tickets', async () => {
    const f = fixture();
    const request = new Request('https://app.test', { headers: { Range: 'bytes=0-3' } });
    const response = await f.provider.stream(id, request);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/960116');
    expect((await response.arrayBuffer()).byteLength).toBe(4);
    expect(f.fetcher.mock.calls.at(-1)?.[1]).toMatchObject({
      headers: { Range: 'bytes=0-3' },
      redirect: 'error',
    });
    expect(response.headers.get('location')).toBeNull();
    expect(
      (await f.provider.stream(id, new Request('https://app.test', { method: 'HEAD' }))).body,
    ).toBeNull();
    await expect(
      f.provider.stream(
        id,
        new Request('https://app.test', { headers: { Range: 'bytes=0-1,3-4' } }),
      ),
    ).rejects.toMatchObject({ status: 416 });
  });

  it('restores catalog metadata by track ID after a server restart without trusting client fields', async () => {
    const f = fixture();
    const restoredId = kugouTrackId('b'.repeat(32), 12, 34);
    const track = await f.provider.track(restoredId);
    expect(track).toMatchObject({
      id: restoredId,
      name: 'Restored song',
      artist: 'Artist',
      album: 'Album',
      source: 'kugou',
    });
    expect(await f.provider.track(restoredId)).toEqual(track);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await expect(f.provider.track('kugou:invalid')).rejects.toThrow('MUSIC_TRACK_UNAVAILABLE');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful HTTP response containing an error page instead of audio', async () => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(Response.json(playback))
      .mockResolvedValueOnce(
        new Response('<html>denied</html>', { headers: { 'Content-Type': 'text/html' } }),
      );
    await expect(f.provider.stream(id, new Request('https://app.test'))).rejects.toThrow(
      'MUSIC_SOURCE_UNAVAILABLE',
    );
  });

  it.each([
    'https://127.0.0.1/cover.jpg',
    'http://localhost/a.mp3',
    'https://fsandroid.kugou.com.evil.test/a.mp3',
    'https://fsandroid.kugou.com:444/a.mp3',
    'https://user@fsandroid.kugou.com/a.mp3',
    'file:///private/file',
  ])('rejects untrusted upstream location %s', (url) => {
    expect(() => kugouAssetUrl(url, 'audio')).toThrow('MUSIC_SOURCE_UNAVAILABLE');
    expect(() => kugouAssetUrl(url, 'cover')).toThrow('MUSIC_SOURCE_UNAVAILABLE');
  });

  it('stops at unavailable entitlements or verification and never requests an alternate unrestricted source', async () => {
    const f = fixture();
    await f.provider.search('Song', 1);
    f.fetcher.mockClear();
    f.fetcher.mockResolvedValue(Response.json({ status: 0, url: [] }));
    await expect(f.provider.resolve(id)).rejects.toThrow('MUSIC_TRACK_UNAVAILABLE');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher
      .mockReset()
      .mockResolvedValue(new Response('{}', { headers: { 'ssa-code': 'verification-required' } }));
    await expect(f.provider.search('Song', 1)).rejects.toThrow('MUSIC_SOURCE_UNAVAILABLE');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not request blank searches or aborted operations, and bounds cover bytes/types', async () => {
    const f = fixture();
    expect(await f.provider.search('', 10)).toEqual([]);
    await expect(f.provider.track(id, AbortSignal.abort())).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.provider.search('Song', 1);
    f.fetcher.mockResolvedValue(
      new Response('bad', { headers: { 'Content-Type': 'image/svg+xml' } }),
    );
    await expect(f.provider.cover(id, new Request('https://app.test'))).rejects.toThrow(
      'MUSIC_SOURCE_UNAVAILABLE',
    );
    f.fetcher.mockResolvedValue(
      new Response('large', {
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '9999999' },
      }),
    );
    await expect(f.provider.cover(id, new Request('https://app.test'))).rejects.toThrow(
      'MUSIC_SOURCE_UNAVAILABLE',
    );
  });

  it('routes the catalog explicitly while leaving library IDs and account scope intact', async () => {
    const library = {
      userId: 'alice',
      search: vi.fn().mockResolvedValue([]),
      track: vi.fn(),
      resolve: vi.fn(),
      stream: vi.fn(),
    } satisfies MusicProvider;
    const kugou = {
      ...library,
      search: vi.fn().mockResolvedValue([]),
      track: vi.fn(),
    } satisfies MusicProvider;
    const provider = new CatalogMusicProvider('alice', library, kugou);
    await provider.search('rain', 20);
    await provider.search('rain', 20, undefined, 'kugou');
    provider.track('owned-file');
    provider.track(id);
    expect(library.search).toHaveBeenCalledWith('rain', 20, undefined);
    expect(kugou.search).toHaveBeenCalledWith('rain', 20, undefined);
    expect(library.track).toHaveBeenCalledWith('owned-file', undefined);
    expect(kugou.track).toHaveBeenCalledWith(id, undefined);
  });
});
