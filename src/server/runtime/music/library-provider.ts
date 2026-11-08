import { z } from 'zod';

import type { MusicTrack } from '@/types/music';
import type {
  MusicLibrary,
  MusicLibraryPlaylist,
  MusicPlaylistTracks,
} from '@/types/music-account';

import type { MusicAccountAccess } from './account-service';
import type { KugouCredentials } from './account-store';
import { MusicError } from './contracts';
import { kugouAssetUrl, KugouMusicProvider, kugouTrackId } from './kugou-provider';

const PAGE_SIZE = 100;
const numericId = z.coerce.string().regex(/^\d{1,20}$/u);
const optionalText = z.string().max(2000).optional().catch(undefined);
const numeric = z.coerce.number().finite().nonnegative().optional().catch(undefined);
const playlistInput = z.object({
  authors: z.unknown().optional(),
  count: numeric,
  is_def: numeric,
  is_del: numeric,
  is_mine: numeric,
  list_create_userid: numericId.optional(),
  listid: numericId,
  name: z.string().max(2000),
  pic: optionalText,
});
const trackInput = z.object({
  album_id: numericId.optional(),
  albuminfo: z.object({ name: optionalText }).optional(),
  cover: optionalText,
  hash: z.string().regex(/^[a-f\d]{32}$/iu),
  mixsongid: numericId.optional(),
  name: z.string().max(2000),
  singerinfo: z.array(z.object({ name: optionalText })).optional(),
  size: numeric,
  timelen: numeric,
});
interface Entry {
  cover?: string;
  playlist: MusicLibraryPlaylist;
}
interface CachedPage {
  entries: Entry[];
  hasMore: boolean;
}
interface Cache {
  expires: number;
  pages: Map<number, CachedPage>;
}
// Private library snapshots are separated from the public track metadata cache.
// Connection IDs are unique per Qingzhou owner/session, checked before every read.
const privateLibraries = new Map<string, Cache>();
export const clearKugouLibraryCache = (connectionId: string) => {
  privateLibraries.delete(connectionId);
};
function cacheFor(id: string) {
  for (const [key, value] of privateLibraries)
    if (value.expires <= Date.now()) privateLibraries.delete(key);
  let cache = privateLibraries.get(id);
  if (!cache) {
    if (privateLibraries.size >= 32) privateLibraries.delete(privateLibraries.keys().next().value!);
    cache = { expires: Date.now() + 60_000, pages: new Map() };
    privateLibraries.set(id, cache);
  }
  return cache;
}
const integer = (value?: number) => Math.floor(Math.max(0, value ?? 0));

export class KugouLibraryProvider extends KugouMusicProvider {
  constructor(
    private access: MusicAccountAccess,
    private http: typeof fetch = fetch,
  ) {
    super('account-library', http, access);
  }

  private async linked(signal?: AbortSignal) {
    const credentials = await this.access.credentials(signal);
    if (!credentials) throw new MusicError('MUSIC_ACCOUNT_REQUIRED', 401);
    return credentials;
  }
  private async current(credentials: KugouCredentials, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!(await this.access.isCurrent(credentials.id))) {
      clearKugouLibraryCache(credentials.id);
      throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    }
  }
  private async fetchPage(
    credentials: KugouCredentials,
    page: number,
    signal?: AbortSignal,
  ): Promise<CachedPage> {
    const response = z
      .object({ status: z.number(), data: z.object({ info: z.array(z.unknown()) }) })
      .parse(
        await this.api(
          '/v7/get_all_list',
          'cloudlist.service.kugou.com',
          { plat: 1, token: credentials.token, userid: credentials.userId },
          signal,
          {
            userid: credentials.userId,
            token: credentials.token,
            total_ver: 979,
            type: 2,
            page,
            pagesize: PAGE_SIZE,
          },
          credentials,
        ),
      );
    if (response.status !== 1) throw new MusicError('MUSIC_LIBRARY_UNAVAILABLE', 502);
    const entries: Entry[] = response.data.info.slice(0, PAGE_SIZE).flatMap((value) => {
      const parsed = playlistInput.safeParse(value);
      if (!parsed.success || parsed.data.is_del === 1) return [];
      const item = parsed.data;
      const owner = item.list_create_userid === credentials.userId || item.is_mine === 1;
      const kind: MusicLibraryPlaylist['kind'] =
        item.name === '我喜欢' && (owner || item.is_def === 1)
          ? 'liked'
          : owner
            ? 'created'
            : item.authors
              ? 'album'
              : 'collected';
      let cover: string | undefined;
      try {
        if (item.pic) cover = kugouAssetUrl(item.pic, 'cover');
      } catch {
        /* Artwork is optional, membership is not. */
      }
      return [
        {
          cover,
          playlist: {
            id: item.listid,
            kind,
            name: item.name.slice(0, 500),
            trackCount: integer(item.count),
            coverUrl: cover
              ? `/api/runtime/music/account/playlists/${item.listid}/cover?revision=${credentials.id}`
              : undefined,
          },
        },
      ];
    });
    await this.current(credentials, signal);
    const result = { entries, hasMore: response.data.info.length >= PAGE_SIZE };
    cacheFor(credentials.id).pages.set(page, result);
    return result;
  }
  private async findPlaylist(credentials: KugouCredentials, id: string, signal?: AbortSignal) {
    const cache = cacheFor(credentials.id);
    for (const page of cache.pages.values()) {
      const found = page.entries.find((entry) => entry.playlist.id === id);
      if (found) return found;
    }
    // Covers and deep selections may arrive in a fresh server process. Validate
    // membership against the signed private list, never a client-provided URL.
    for (let page = 1; page <= 50; page++) {
      const data = cache.pages.get(page) ?? (await this.fetchPage(credentials, page, signal));
      const found = data.entries.find((entry) => entry.playlist.id === id);
      if (found) return found;
      if (!data.hasMore) break;
    }
    throw new MusicError('MUSIC_PLAYLIST_UNAVAILABLE', 404);
  }
  async library(page = 1, signal?: AbortSignal): Promise<MusicLibrary> {
    const boundedSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    const credentials = await this.linked(boundedSignal);
    const result = await this.fetchPage(credentials, page, boundedSignal);
    return {
      hasMore: result.hasMore,
      page,
      playlists: result.entries.map((entry) => entry.playlist),
      revision: credentials.id,
    };
  }
  async playlist(id: string, page = 1, signal?: AbortSignal): Promise<MusicPlaylistTracks> {
    const boundedSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    const credentials = await this.linked(boundedSignal);
    const entry = await this.findPlaylist(credentials, id, boundedSignal);
    const response = z
      .object({
        status: z.number(),
        data: z.object({
          count: numeric,
          info: z.array(z.unknown()),
          listid: numericId.optional(),
          userid: numericId.optional(),
        }),
      })
      .parse(
        await this.api(
          '/v4/get_list_all_file_v3',
          'cloudlist.service.kugou.com',
          {},
          boundedSignal,
          {
            listid: id,
            userid: credentials.userId,
            token: credentials.token,
            type: 0,
            page,
            pagesize: PAGE_SIZE,
            area_code: 1,
            allplatform: 1,
            show_cover: 1,
          },
          credentials,
        ),
      );
    if (
      response.status !== 1 ||
      (response.data.userid && response.data.userid !== credentials.userId) ||
      (response.data.listid && response.data.listid !== id)
    )
      throw new MusicError('MUSIC_PLAYLIST_UNAVAILABLE', 404);
    const tracks: MusicTrack[] = response.data.info.slice(0, PAGE_SIZE).flatMap((raw) => {
      const parsed = trackInput.safeParse(raw);
      if (!parsed.success) return [];
      const item = parsed.data;
      const nameParts = item.name.split(' - ');
      const artist =
        item.singerinfo
          ?.map((singer) => singer.name)
          .filter(Boolean)
          .join('、') || (nameParts.length > 1 ? nameParts[0] : undefined);
      const prefix = artist ? `${artist} - ` : '';
      const trackId = kugouTrackId(item.hash, item.album_id, item.mixsongid);
      // These private list names/metadata never enter publicTracks. Artwork and
      // playback resolve through the existing public track service by hash.
      return [
        {
          album: item.albuminfo?.name?.slice(0, 500),
          artist: artist?.slice(0, 500),
          coverUrl: item.cover
            ? `/api/runtime/music/tracks/${encodeURIComponent(trackId)}/cover`
            : undefined,
          durationMs: integer(item.timelen),
          id: trackId,
          mimeType: 'audio/mpeg',
          name: prefix && item.name.startsWith(prefix) ? item.name.slice(prefix.length) : item.name,
          size: integer(item.size),
          source: 'kugou' as const,
          version: item.hash.toLowerCase(),
        },
      ];
    });
    await this.current(credentials, boundedSignal);
    const total = integer(response.data.count ?? entry.playlist.trackCount);
    return {
      hasMore: page * PAGE_SIZE < total,
      page,
      playlist: entry.playlist,
      revision: credentials.id,
      total,
      tracks,
    };
  }
  async playlistCover(id: string, request: Request) {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    const credentials = await this.linked(signal);
    if (new URL(request.url).searchParams.get('revision') !== credentials.id)
      throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    const entry = await this.findPlaylist(credentials, id, signal);
    if (!entry.cover) throw new MusicError('MUSIC_PLAYLIST_UNAVAILABLE', 404);
    const response = await this.http(entry.cover, { redirect: 'error', signal });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (
      !response.ok ||
      !type ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(type) ||
      Number(response.headers.get('content-length')) > 3 * 1024 * 1024
    ) {
      await response.body?.cancel();
      throw new MusicError('MUSIC_LIBRARY_UNAVAILABLE', 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MusicError('MUSIC_LIBRARY_UNAVAILABLE', 502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 3 * 1024 * 1024) {
          await reader.cancel();
          throw new MusicError('MUSIC_LIBRARY_UNAVAILABLE', 502);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    await this.current(credentials, signal);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Length': String(size),
        'Content-Type': type,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}
