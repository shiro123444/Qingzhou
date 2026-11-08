// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { MusicAccountClient } from './music-account';

const revision = 'a6f6d77d-85a5-4541-bfa4-3b81cc68a2ab';
const playlist = {
  coverUrl: `/api/runtime/music/account/playlists/7/cover?revision=${revision}`,
  id: '7',
  kind: 'liked',
  name: 'Saved songs',
  trackCount: 120,
};
const page = { hasMore: false, page: 2, playlists: [playlist], revision };
const tracks = { hasMore: false, page: 2, playlist, revision, total: 120, tracks: [] };
const envelope = (result: unknown) => Response.json({ result, success: true });

it('reads bounded private pages through the authenticated same-origin API with cancellation', async () => {
  const signal = new AbortController().signal;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(envelope(page));
  const client = new MusicAccountClient(fetcher);
  expect(await client.library(2, signal)).toEqual(page);
  expect(fetcher).toHaveBeenCalledWith(
    '/api/runtime/music/account',
    expect.objectContaining({ credentials: 'same-origin', method: 'POST', signal }),
  );
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    operation: 'library',
    page: 2,
  });
  fetcher.mockResolvedValueOnce(envelope(tracks));
  expect(await client.playlist('7', 2, signal)).toEqual(tracks);
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
    operation: 'playlist',
    page: 2,
    playlistId: '7',
  });
});

it('rejects private credential fields, arbitrary covers, oversized pages and mismatched results', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = new MusicAccountClient(fetcher);
  for (const result of [
    { ...page, token: 'must-not-reach-ui' },
    { ...page, playlists: [{ ...playlist, coverUrl: 'https://other.test/pixel' }] },
    { ...page, playlists: Array.from({ length: 101 }, () => playlist) },
    { ...page, page: 1 },
  ]) {
    fetcher.mockResolvedValueOnce(envelope(result));
    await expect(client.library(2)).rejects.toThrow();
  }
  fetcher.mockResolvedValueOnce(envelope({ ...tracks, playlist: { ...playlist, id: '8' } }));
  await expect(client.playlist('7', 2)).rejects.toThrow('MUSIC_LIBRARY_MISMATCH');
  fetcher.mockResolvedValueOnce(envelope({ ...tracks, page: 1 }));
  await expect(client.playlist('7', 2)).rejects.toThrow('MUSIC_LIBRARY_MISMATCH');
});

it('surfaces an expired account without retrying its private library request', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ code: 'MUSIC_ACCOUNT_EXPIRED', success: false }, { status: 401 }),
    );
  await expect(new MusicAccountClient(fetcher).library()).rejects.toThrow('MUSIC_ACCOUNT_EXPIRED');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
