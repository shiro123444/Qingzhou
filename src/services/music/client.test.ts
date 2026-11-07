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
