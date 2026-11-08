// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import { musicLibrarySchema, musicPlaylistTracksSchema } from '@/types/music-account';

import type { MusicAccountAccess } from './account-service';
import type { KugouCredentials } from './account-store';
import { KugouMusicProvider } from './kugou-provider';
import { clearKugouLibraryCache, KugouLibraryProvider } from './library-provider';

function fixture(userId = '101') {
  const connection: KugouCredentials = {
    appId: 3116,
    connectedAt: Date.now(),
    device: { dev: 'A'.repeat(32), dfid: '-', mid: 'a'.repeat(32) },
    displayName: 'Listener',
    expiresAt: Date.now() + 100000,
    id: randomUUID(),
    token: 'private-test-token',
    userId,
  };
  const account: MusicAccountAccess = {
    credentials: vi.fn().mockResolvedValue(connection),
    expire: vi.fn(),
    isCurrent: vi.fn().mockResolvedValue(true),
  };
  const items = [
    {
      listid: '3',
      name: '我喜欢',
      list_create_userid: userId,
      is_def: 1,
      count: 250,
      pic: 'http://imge.kugou.com/custom/{size}/liked.jpg',
    },
    { listid: '4', name: 'Private created title', list_create_userid: userId, count: 1 },
    {
      listid: '5',
      name: 'Collected title',
      list_create_userid: '999',
      count: 3,
      pic: 'http://c1.kgimg.com/custom/{size}/collection.jpg',
    },
    {
      listid: '6',
      name: 'Collected album',
      list_create_userid: '999',
      count: 12,
      authors: [{ name: 'Artist' }],
    },
  ];
  const hash = randomBytes(16).toString('hex');
  const song = {
    hash,
    name: 'Artist - Private library title',
    singerinfo: [{ name: 'Artist' }],
    albuminfo: { name: 'Album' },
    album_id: '12',
    mixsongid: '34',
    timelen: 240000,
    size: 4000000,
    cover: 'http://imge.kugou.com/cover.jpg',
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v7/get_all_list')
      return Response.json({ status: 1, data: { info: items } });
    if (url.pathname === '/v4/get_list_all_file_v3') {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        status: 1,
        data: { info: [song], count: 250, userid: userId, listid: body.listid },
      });
    }
    if (['imge.kugou.com', 'c1.kgimg.com'].includes(url.hostname))
      return new Response(new Uint8Array([255, 216, 255]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    throw new Error('Unexpected upstream');
  });
  return {
    account,
    connection,
    fetcher,
    hash,
    items,
    library: new KugouLibraryProvider(account, fetcher),
    song,
  };
}

it('maps the signed personal list into likes, created, collected and albums without exposing upstream secrets', async () => {
  const f = fixture();
  const result = musicLibrarySchema.parse(await f.library.library());
  expect(result.playlists.map((item) => item.kind)).toEqual([
    'liked',
    'created',
    'collected',
    'album',
  ]);
  expect(result.revision).toBe(f.connection.id);
  expect(result.hasMore).toBe(false);
  expect(result.playlists[0].coverUrl).toBe(
    `/api/runtime/music/account/playlists/3/cover?revision=${f.connection.id}`,
  );
  expect(result.playlists[2].coverUrl).toBe(
    `/api/runtime/music/account/playlists/5/cover?revision=${f.connection.id}`,
  );
  expect(JSON.stringify(result)).not.toMatch(
    /private-test-token|list_create_userid|imge.kugou.com/u,
  );
  const input = new URL(String(f.fetcher.mock.calls[0][0]));
  const body = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body));
  expect(input.searchParams.get('appid')).toBe('3116');
  expect(body).toMatchObject({
    userid: '101',
    token: f.connection.token,
    page: 1,
    pagesize: 100,
    type: 2,
  });
});

it('pages the private favorites endpoint with correct totals and does not promote private metadata into the public cache', async () => {
  const f = fixture();
  const result = musicPlaylistTracksSchema.parse(await f.library.playlist('3', 2));
  expect(result).toMatchObject({ total: 250, hasMore: true, page: 2, revision: f.connection.id });
  expect(result.tracks[0]).toMatchObject({
    name: 'Private library title',
    artist: 'Artist',
    album: 'Album',
    durationMs: 240000,
    source: 'kugou',
  });
  const request = f.fetcher.mock.calls.find(
    ([input]) => new URL(String(input)).pathname === '/v4/get_list_all_file_v3',
  )!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    listid: '3',
    userid: '101',
    type: 0,
    page: 2,
    pagesize: 100,
    show_cover: 1,
  });
  const publicFetch = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      status: 1,
      data: [{ hash: f.hash, name: 'Public catalog title', info: { duration: 240000 } }],
    }),
  );
  const publicProvider = new KugouMusicProvider('another-account', publicFetch);
  expect((await publicProvider.track(result.tracks[0].id)).name).toBe('Public catalog title');
  expect(publicFetch).toHaveBeenCalledOnce();
  expect(new URL(String(publicFetch.mock.calls[0][0])).searchParams.has('token')).toBe(false);
});

it('uses playlist count when a page omits it, preserves true zero, and does not mistake a lone title for an artist', async () => {
  const f = fixture();
  await f.library.library();
  f.fetcher.mockResolvedValueOnce(
    Response.json({
      status: 1,
      data: { info: [{ hash: f.hash, name: 'Title only', timelen: 1000 }] },
    }),
  );
  const page = await f.library.playlist('3');
  expect(page.total).toBe(250);
  expect(page.tracks[0].artist).toBeUndefined();
  f.fetcher.mockResolvedValueOnce(Response.json({ status: 1, data: { count: 0, info: [] } }));
  expect(await f.library.playlist('3')).toMatchObject({ total: 0, tracks: [], hasMore: false });
});

it('cannot use another linked account cache or an unverified collection ID', async () => {
  const alice = fixture('101');
  await alice.library.library();
  const bob = fixture('202');
  bob.items.splice(0, 1);
  await expect(bob.library.playlist('3')).rejects.toThrow('MUSIC_PLAYLIST_UNAVAILABLE');
  expect(
    bob.fetcher.mock.calls.every(
      ([input]) => new URL(String(input)).pathname !== '/v4/get_list_all_file_v3',
    ),
  ).toBe(true);
  vi.mocked(bob.account.credentials).mockResolvedValue(undefined);
  await expect(bob.library.library()).rejects.toThrow('MUSIC_ACCOUNT_REQUIRED');
});

it('discards library or track data if the linked account is revoked while the upstream response arrives', async () => {
  const f = fixture();
  vi.mocked(f.account.isCurrent).mockResolvedValue(false);
  await expect(f.library.library()).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
  vi.mocked(f.account.isCurrent).mockResolvedValue(true);
  await f.library.library();
  vi.mocked(f.account.isCurrent).mockResolvedValue(false);
  await expect(f.library.playlist('3')).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
});

it('serves a real same-origin cover only for current membership, with strict type, size, and revision checks', async () => {
  const f = fixture();
  const data = await f.library.library();
  const request = new Request('https://app.test' + data.playlists[0].coverUrl);
  const response = await f.library.playlistCover('3', request);
  expect(response.headers.get('content-type')).toBe('image/jpeg');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect((await response.arrayBuffer()).byteLength).toBe(3);
  const options = f.fetcher.mock.calls.at(-1)![1];
  expect(options?.redirect).toBe('error');
  expect(new Headers(options?.headers).has('cookie')).toBe(false);
  expect(new Headers(options?.headers).has('authorization')).toBe(false);
  await expect(
    f.library.playlistCover('3', new Request('https://app.test?revision=' + randomUUID())),
  ).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
  f.fetcher.mockResolvedValueOnce(
    new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
  );
  await expect(f.library.playlistCover('3', request)).rejects.toThrow('MUSIC_LIBRARY_UNAVAILABLE');
  f.fetcher.mockResolvedValueOnce(
    new Response('large', {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '9999999' },
    }),
  );
  await expect(f.library.playlistCover('3', request)).rejects.toThrow('MUSIC_LIBRARY_UNAVAILABLE');
  clearKugouLibraryCache(f.connection.id);
  const before = f.fetcher.mock.calls.filter(
    ([input]) => new URL(String(input)).pathname === '/v7/get_all_list',
  ).length;
  await f.library.playlist('3');
  expect(
    f.fetcher.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === '/v7/get_all_list',
    ),
  ).toHaveLength(before + 1);
});
