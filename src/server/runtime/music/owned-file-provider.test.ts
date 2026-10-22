// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { type MusicFile, type MusicFiles, type MusicStorage } from './contracts';
import { musicByteRange, OwnedFileMusicProvider } from './owned-file-provider';

const file: MusicFile = {
  id: 'track',
  userId: 'alice',
  name: 'Rain.mp3',
  fileType: 'audio/mpeg',
  size: 10,
  updatedAt: new Date('2026-10-22'),
  url: 'private/audio.mp3',
};
function fixture() {
  const files: MusicFiles = {
    findById: vi.fn().mockResolvedValue(file),
    queryAudio: vi.fn().mockResolvedValue([file]),
  };
  const storage: MusicStorage = {
    getFileMetadata: vi.fn().mockResolvedValue({ contentLength: 10 }),
    createPreSignedUrlForPreview: vi
      .fn()
      .mockResolvedValue('https://storage.test/private?signature=secret'),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('0123456789', { headers: { 'Content-Length': '10' } }));
  const provider = new OwnedFileMusicProvider('alice', files, storage, fetcher);
  const stream = (headers?: HeadersInit, method = 'GET', signal?: AbortSignal) =>
    provider.stream('track', new Request('https://app.test/stream', { headers, method, signal }));
  return { provider, files, storage, fetcher, stream };
}

describe('owned audio media', () => {
  it.each([
    ['bytes=2-5', 2, 5],
    ['bytes=3-', 3, 9],
    ['bytes=-4', 6, 9],
    ['bytes=0-99', 0, 9],
    ['bytes=-99', 0, 9],
  ])('normalizes %s', (value, start, end) =>
    expect(musicByteRange(value, 10)).toEqual({ start, end }),
  );
  it.each([
    'bytes=10-',
    'bytes=5-3',
    'bytes=-0',
    'bytes=-',
    'bytes=1-2,4-5',
    'items=0-1',
    'bytes=9007199254740992-',
  ])('rejects %s', (value) => {
    expect(() => musicByteRange(value, 10)).toThrow('MUSIC_RANGE_INVALID');
  });
  it('returns only track DTOs and fresh same-origin playback paths', async () => {
    const f = fixture();
    const result = await f.provider.search('rain', 2);
    expect(f.files.queryAudio).toHaveBeenCalledWith({ query: 'rain', limit: 2 });
    expect(result[0]).toMatchObject({ name: file.name, source: 'library' });
    expect(JSON.stringify(result)).not.toContain('private');
    const first = await f.provider.resolve('track');
    expect(first.src).toMatch(/^\/api\/runtime\/music\/tracks\/track\/stream\?requestId=/u);
    expect((await f.provider.resolve('track')).src).not.toBe(first.src);
    expect(f.storage.createPreSignedUrlForPreview).not.toHaveBeenCalled();
  });
  it.each([undefined, { ...file, userId: 'bob' }, { ...file, fileType: 'text/plain' }])(
    'denies unknown, foreign and non-audio records',
    async (record) => {
      const f = fixture();
      vi.mocked(f.files.findById).mockResolvedValue(record);
      await expect(f.stream()).rejects.toMatchObject({
        code: 'MUSIC_TRACK_UNAVAILABLE',
        status: 404,
      });
      expect(f.storage.getFileMetadata).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it('streams a full response without exposing upstream headers or URL', async () => {
    const f = fixture();
    const upstream = new Response('0123456789', {
      headers: {
        'Content-Length': '10',
        'Set-Cookie': 'private',
        'location': 'https://secret.test',
        'etag': '"v1"',
      },
    });
    f.fetcher.mockResolvedValue(upstream);
    const response = await f.stream();
    expect(response.body).toBe(upstream.body);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('location')).toBe(false);
  });
  it('renews one expired signature, preserving the exact Range and cancellation signal', async () => {
    const f = fixture();
    const expired = new Response('private upstream error', { status: 403 });
    f.fetcher.mockResolvedValueOnce(expired).mockResolvedValueOnce(
      new Response('2345', {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' },
      }),
    );
    const response = await f.stream({ Range: 'bytes=2-5' });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(f.storage.createPreSignedUrlForPreview).toHaveBeenCalledTimes(2);
    expect(expired.bodyUsed).toBe(true);
    for (const [, options] of f.fetcher.mock.calls) {
      expect(new Headers(options?.headers).get('range')).toBe('bytes=2-5');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.redirect).toBe('error');
    }
  });
  it('stops after two expired responses', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response('secret', { status: 403 }));
    await expect(f.stream()).rejects.toMatchObject({
      code: 'MUSIC_STORAGE_UNAVAILABLE',
      status: 502,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    new Response('0123456789'),
    new Response('2345', { status: 206, headers: { 'Content-Range': 'bytes 3-6/10' } }),
    new Response('2345', {
      status: 206,
      headers: { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '9' },
    }),
  ])('rejects ignored or corrupt range responses', async (upstream) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(upstream);
    await expect(f.stream({ Range: 'bytes=2-5' })).rejects.toMatchObject({ status: 502 });
  });
  it('honours If-Range fallback to a complete new representation', async () => {
    const f = fixture();
    const response = await f.stream({ 'Range': 'bytes=2-5', 'If-Range': '"old"' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
  });
  it('answers unsatisfiable ranges without downloading media', async () => {
    const f = fixture();
    const response = await f.stream({ Range: 'bytes=20-' });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('handles authenticated HEAD without using a GET signature for HEAD', async () => {
    const f = fixture();
    const response = await f.stream({ Range: 'bytes=2-5' }, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe('10');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does no IO after cancellation', async () => {
    const f = fixture();
    await expect(f.stream(undefined, 'GET', AbortSignal.abort())).rejects.toThrow();
    expect(f.files.findById).not.toHaveBeenCalled();
  });
  it('maps deleted storage objects to the same public unavailable response', async () => {
    const f = fixture();
    vi.mocked(f.storage.getFileMetadata).mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    await expect(f.stream()).rejects.toMatchObject({
      code: 'MUSIC_TRACK_UNAVAILABLE',
      status: 404,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
