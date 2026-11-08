// @vitest-environment node
import { File } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { musicTestWav } from '../../../tests/fixtures/musicAudio';
import { MusicClient, type MusicUploadPort } from './client';

const track = {
  id: 'one',
  mimeType: 'audio/wav',
  name: 'rain.wav',
  size: 16044,
  source: 'library',
  version: 'v1',
};
function fixture() {
  const port: MusicUploadPort = {
    upload: vi.fn().mockResolvedValue({ path: 'music/owned.wav' }),
    register: vi.fn().mockResolvedValue({ id: 'one' }),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => Response.json({ success: true, result: track }));
  return { port, fetcher, client: new MusicClient(fetcher, port) };
}

describe('audio upload transport', () => {
  it('discards a lyric response that finishes after track cancellation', async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      abort.abort();
      return Response.json({
        success: true,
        result: { trackId: 'one', format: 'krc', text: '[0,100]<0,100,0>Word' },
      });
    });
    const client = new MusicClient(fetcher);
    await expect(client.lyrics('one', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.lyrics('one', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves decoded KRC and rejects unknown formats or a response for another track', async () => {
    const f = fixture();
    const text = '[1000,1000]<0,300,0>A<300,700,0>word';
    f.fetcher.mockResolvedValueOnce(
      Response.json({ success: true, result: { trackId: 'one', format: 'krc', text } }),
    );
    expect(await f.client.lyrics('one')).toEqual({ trackId: 'one', format: 'krc', text });
    f.fetcher.mockResolvedValueOnce(
      Response.json({ success: true, result: { trackId: 'other', format: 'krc', text } }),
    );
    await expect(f.client.lyrics('one')).rejects.toThrow('MISMATCH');
    f.fetcher.mockResolvedValueOnce(
      Response.json({ success: true, result: { trackId: 'one', format: 'raw', text } }),
    );
    await expect(f.client.lyrics('one')).rejects.toThrow();
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { trackId: 'one', format: 'krc', text: '词'.repeat(50000) },
      }),
    );
    await expect(f.client.lyrics('one')).rejects.toThrow('MUSIC_LYRICS_LIMIT');
  });
  it('gets bounded lyrics for exactly the requested track and forwards cancellation', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { trackId: 'one', format: 'lrc', text: '[00:00]A line' },
      }),
    );
    expect(await f.client.lyrics('one', signal)).toMatchObject({
      trackId: 'one',
      text: '[00:00]A line',
    });
    expect(JSON.parse(f.fetcher.mock.calls[0][1]!.body as string)).toEqual({
      operation: 'music.lyrics.get',
      input: { trackId: 'one' },
    });
    expect(f.fetcher.mock.calls[0][1]?.signal).toBe(signal);
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { trackId: 'other', format: 'lrc', text: '[00:00]Wrong' },
      }),
    );
    await expect(f.client.lyrics('one')).rejects.toThrow('MISMATCH');
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { trackId: 'one', format: 'lrc', text: '字'.repeat(50000) },
      }),
    );
    await expect(f.client.lyrics('one')).rejects.toThrow('MUSIC_LYRICS_LIMIT');
  });
  it('calls a native-style fetch without binding the MusicClient as its receiver', async () => {
    const fetcher: typeof fetch = async function (this: unknown) {
      expect(this).toBeUndefined();
      return Response.json({ success: true, result: { tracks: [track] } });
    };
    expect(await new MusicClient(fetcher).search()).toEqual([track]);
  });
  it('sniffs real audio, uploads it and registers a normal file without starting document processing', async () => {
    const f = fixture();
    expect(
      await f.client.uploadAudio(new File([musicTestWav()], 'rain.wav', { type: 'text/plain' })),
    ).toEqual(track);
    expect(f.port.register).toHaveBeenCalledWith(
      expect.objectContaining({
        fileType: 'audio/wav',
        name: 'rain.wav',
        size: 16044,
        url: 'music/owned.wav',
        hash: expect.stringMatching(/^[a-f\d]{64}$/u),
      }),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.fetcher.mock.calls[0][1]!.body as string)).toEqual({
      operation: 'music.track.get',
      input: { trackId: 'one' },
    });
  });
  it('rejects forged MIME and empty files before network IO', async () => {
    const f = fixture();
    await expect(
      f.client.uploadAudio(new File(['not audio'], 'fake.mp3', { type: 'audio/mpeg' })),
    ).rejects.toThrow('MUSIC_AUDIO_REQUIRED');
    await expect(f.client.uploadAudio(new File([], 'empty.mp3'))).rejects.toThrow(
      'MUSIC_UPLOAD_LIMIT',
    );
    expect(f.port.upload).not.toHaveBeenCalled();
  });
  it('does not register a failed upload', async () => {
    const f = fixture();
    vi.mocked(f.port.upload).mockRejectedValue(new Error('upload failed'));
    await expect(f.client.uploadAudio(new File([musicTestWav()], 'rain.wav'))).rejects.toThrow(
      'upload failed',
    );
    expect(f.port.register).not.toHaveBeenCalled();
  });
  it('propagates cancellation and avoids registration after an upload finishes late', async () => {
    const f = fixture();
    const abort = new AbortController();
    vi.mocked(f.port.upload).mockImplementation(async (_file, controller) => {
      abort.abort();
      expect(controller.signal.aborted).toBe(true);
      return { path: 'orphan.wav' };
    });
    await expect(
      f.client.uploadAudio(new File([musicTestWav()], 'rain.wav'), abort.signal),
    ).rejects.toThrow();
    expect(f.port.register).not.toHaveBeenCalled();
  });
  it('does not retry an expired login', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }));
    await expect(new MusicClient(fetcher).resolve('one')).rejects.toThrow('UNAUTHORIZED');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
