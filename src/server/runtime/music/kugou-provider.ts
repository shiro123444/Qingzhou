import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { MusicTrack } from '@/types/music';

import type { MusicAccountAccess } from './account-service';
import type { KugouCredentials } from './account-store';
import { MusicError, type MusicProvider } from './contracts';

// Protocol interoperability with MakcRe/KuGouMusicApi (MIT), the backend used by
// MoeKoeMusic. Public catalog data and account-granted playback are separated;
// credentials stay in the server vault. No entitlement or verification bypass.
const APP_ID = 1005;
const CLIENT_VERSION = 20489;
const DEVICE_ID = randomBytes(16).toString('hex');
const YOUTH_MEDIA_HOSTS = ['fs.youthandroid.kugou.com', 'fs.youthandroid2.kugou.com'];
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const text = z.string().max(2000).optional().catch(undefined);
const number = z.coerce.number().finite().nonnegative().optional().catch(undefined);
const searchItem = z.object({
  AlbumID: z.union([z.string(), z.number()]).optional(),
  AlbumName: text,
  Duration: number,
  FileHash: z.string().regex(/^[a-f\d]{32}$/iu),
  FileName: text,
  FileSize: number,
  Image: text,
  MixSongID: z.union([z.string(), z.number()]).optional(),
  Privilege: number,
  SingerName: text,
  SongName: text,
});
const metadataItem = z.object({
  albumname: text,
  hash: z.string().regex(/^[a-f\d]{32}$/iu),
  info: z.object({ duration: number, filesize: number, image: text }).optional(),
  name: text,
  privilege: number,
  singername: text,
});
const urlResponse = z.object({
  extName: text,
  hash_offset: z.object({ end_ms: number, start_ms: number }).optional(),
  status: z.number(),
  timeLength: number,
  url: z.array(z.string()).optional(),
});
interface TrackEntry {
  cover?: string;
  expires: number;
  track: MusicTrack;
}
const publicTracks = new Map<string, TrackEntry>();
function remember(id: string, track: MusicTrack, cover?: string) {
  if (publicTracks.size >= 500) publicTracks.delete(publicTracks.keys().next().value!);
  publicTracks.set(id, { cover, expires: Date.now() + 300_000, track });
  return track;
}
const safeInteger = (value: unknown) =>
  /^\d{1,16}$/u.test(String(value ?? '')) ? String(value) : '0';
const integer = (value?: number) => Math.floor(Math.max(0, value ?? 0));

export function kugouTrackId(hash: string, album?: unknown, mix?: unknown) {
  return `kugou:${hash.toLowerCase()}:${safeInteger(album)}:${safeInteger(mix)}`;
}
function parseId(id: string) {
  const match = /^kugou:([a-f\d]{32}):(\d{1,16}):(\d{1,16})$/u.exec(id);
  if (!match) throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
  return { album: match[2], hash: match[1], mix: match[3] };
}

/** Server-derived upstream locations only; never accept an arbitrary URL from a client. */
export function kugouAssetUrl(raw: string, kind: 'cover' | 'audio') {
  try {
    const url = new URL(raw.replaceAll('{size}', '480'));
    const permitted =
      kind === 'cover'
        ? ['imge.kugou.com', 'imgessl.kugou.com'].includes(url.hostname)
        : YOUTH_MEDIA_HOSTS.includes(url.hostname) ||
          /^(?:fsandroid|fsmobile|fsios|fsweb)(?:\.[a-z\d-]+)?\.kugou\.com$/u.test(url.hostname);
    if (
      !permitted ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error('invalid');
    // These two official concept-client CDNs issue HTTP URLs and do not present
    // a matching TLS certificate. Preserve only their issued protocol; never
    // downgrade an HTTPS response or disable certificate checks. No account
    // token/cookie is sent to media CDNs; the browser still uses our own origin.
    if (!(kind === 'audio' && YOUTH_MEDIA_HOSTS.includes(url.hostname))) url.protocol = 'https:';
    return url.href;
  } catch {
    throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
  }
}

async function boundedBytes(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class KugouMusicProvider implements MusicProvider {
  constructor(
    readonly userId: string,
    private fetcher: typeof fetch = fetch,
    private account?: MusicAccountAccess,
  ) {}

  private async api(
    path: string,
    router: string,
    parameters: Record<string, string | number>,
    signal?: AbortSignal,
    body?: object,
    credentials?: KugouCredentials,
  ) {
    signal?.throwIfAborted();
    const params: Record<string, string | number> = {
      appid: credentials?.appId ?? APP_ID,
      clienttime: Math.floor(Date.now() / 1000),
      clientver: CLIENT_VERSION,
      dfid: credentials?.device.dfid ?? '-',
      mid: credentials?.device.mid ?? DEVICE_ID,
      uuid: '-',
      ...(credentials ? { token: credentials.token, userid: credentials.userId } : {}),
      ...parameters,
    };
    if (path === '/v5/url')
      params.key = md5(
        `${params.hash}${credentials ? '185672dd44712f60bb1736df5a377e82' : '57ae12eb6890223e355ccfcb74edf70d'}${params.appid}${params.mid}${credentials?.userId ?? 0}`,
      );
    const serialized = body ? JSON.stringify(body) : '';
    const salt = credentials ? 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA' : 'OIlwieks28dk2k092lksi2UIkp';
    params.signature = md5(
      salt +
        Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join('') +
        serialized +
        salt,
    );
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    );
    const response = await this.fetcher(`https://gateway.kugou.com${path}?${query}`, {
      body: body ? serialized : undefined,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'clienttime': String(params.clienttime),
        'dfid': String(params.dfid),
        'mid': String(params.mid),
        'kg-rc': '1',
        'kg-rec': '1',
        'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        'kg-thash': '5d816a0',
        'x-router': router,
      },
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12_000)]),
    });
    if (!response.ok || response.headers.has('ssa-code')) {
      await response.body?.cancel();
      if (credentials && response.headers.has('ssa-code'))
        throw new MusicError('MUSIC_ACCOUNT_VERIFICATION_REQUIRED', 403);
      if (credentials && [401, 403].includes(response.status)) {
        await this.account?.expire(credentials.id);
        throw new MusicError('MUSIC_ACCOUNT_EXPIRED', 401);
      }
      throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
    }
    const result: unknown = JSON.parse(
      new TextDecoder().decode(await boundedBytes(response, 2 * 1024 * 1024)),
    );
    const failure = z
      .object({
        error: z.string().optional(),
        error_msg: z.string().optional(),
        message: z.string().optional(),
        status: z.number().optional(),
      })
      .safeParse(result);
    if (
      credentials &&
      failure.success &&
      failure.data.status === 0 &&
      /token.*(?:invalid|expired|失效|过期)|登录.*(?:失效|过期)|请.*登录/iu.test(
        [failure.data.error, failure.data.error_msg, failure.data.message]
          .filter(Boolean)
          .join(' '),
      )
    ) {
      await this.account?.expire(credentials.id);
      throw new MusicError('MUSIC_ACCOUNT_EXPIRED', 401);
    }
    return result;
  }

  async search(query: string, limit: number, signal?: AbortSignal) {
    if (!query.trim()) return [];
    const response = z
      .object({ status: z.number(), data: z.object({ lists: z.array(z.unknown()) }) })
      .parse(
        await this.api(
          '/v2/search/song',
          'complexsearch.kugou.com',
          {
            area_code: 1,
            dopicfull: 1,
            iscorrection: 1,
            keyword: query,
            page: 1,
            pagesize: Math.min(50, limit),
            platform: 'AndroidFilter',
            privilegefilter: 0,
          },
          signal,
        ),
      );
    if (response.status !== 1) throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
    return response.data.lists.slice(0, limit).flatMap((raw) => {
      const parsed = searchItem.safeParse(raw);
      if (!parsed.success) return [];
      const song = parsed.data;
      const id = kugouTrackId(song.FileHash, song.AlbumID, song.MixSongID);
      let cover: string | undefined;
      try {
        if (song.Image) cover = kugouAssetUrl(song.Image, 'cover');
      } catch {
        /* Missing artwork remains optional. */
      }
      return [
        remember(
          id,
          {
            album: song.AlbumName?.slice(0, 500),
            artist: song.SingerName?.slice(0, 500),
            coverUrl: cover
              ? `/api/runtime/music/tracks/${encodeURIComponent(id)}/cover`
              : undefined,
            durationMs: integer((song.Duration ?? 0) * 1000),
            id,
            mimeType: 'audio/mpeg',
            name: song.SongName || song.FileName || song.FileHash,
            playbackKind: song.Privilege ? 'preview' : 'full',
            size: integer(song.FileSize),
            source: 'kugou',
            version: song.FileHash.toLowerCase(),
          },
          cover,
        ),
      ];
    });
  }

  async track(id: string, signal?: AbortSignal): Promise<MusicTrack> {
    signal?.throwIfAborted();
    const { hash, album } = parseId(id);
    const cached = publicTracks.get(id);
    if (cached && cached.expires > Date.now()) return cached.track;
    const response = z.object({ status: z.number(), data: z.array(metadataItem) }).parse(
      await this.api('/v2/get_res_privilege/lite', 'media.store.kugou.com', {}, signal, {
        appid: APP_ID,
        area_code: 1,
        behavior: 'play',
        clientver: CLIENT_VERSION,
        need_hash_offset: 1,
        qualities: ['128'],
        relate: 1,
        resource: [{ album_id: album, hash, page_id: 0, type: 'audio' }],
        support_verify: 1,
      }),
    );
    const song = response.data.find((item) => item.hash.toLowerCase() === hash);
    if (response.status !== 1 || !song?.name) throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    let cover: string | undefined;
    try {
      if (song.info?.image) cover = kugouAssetUrl(song.info.image, 'cover');
    } catch {
      /* Optional. */
    }
    const artist = song.singername?.slice(0, 500);
    const prefix = artist ? `${artist} - ` : '';
    return remember(
      id,
      {
        album: song.albumname?.slice(0, 500),
        artist,
        coverUrl: cover ? `/api/runtime/music/tracks/${encodeURIComponent(id)}/cover` : undefined,
        durationMs: integer(song.info?.duration),
        id,
        mimeType: 'audio/mpeg',
        name: prefix && song.name.startsWith(prefix) ? song.name.slice(prefix.length) : song.name,
        playbackKind: song.privilege ? 'preview' : 'full',
        size: integer(song.info?.filesize),
        source: 'kugou',
        version: hash,
      },
      cover,
    );
  }

  private async playback(id: string, signal?: AbortSignal, expectedAccount?: string | null) {
    const { hash, album, mix } = parseId(id);
    const credentials = await this.account?.credentials(signal);
    const accountRevision = credentials?.id ?? 'anonymous';
    if (expectedAccount && expectedAccount !== accountRevision)
      throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    const requestUrl = async (auth?: KugouCredentials) =>
      urlResponse.parse(
        await this.api(
          '/v5/url',
          'trackercdn.kugou.com',
          {
            IsFreePart: auth ? 0 : 1,
            album_audio_id: mix,
            album_id: album,
            area_code: 1,
            behavior: 'play',
            cdnBackup: 1,
            clientver: 11430,
            cmd: 26,
            hash,
            module: '',
            page_id: auth ? 967177915 : 151369488,
            pid: auth ? 411 : 2,
            pidversion: 3001,
            ppage_id: auth ? '356753938,823673182,967485191' : '463467626,350369493,788954147',
            quality: 128,
            ssa_flag: 'is_fromtrack',
            version: 11430,
          },
          signal,
          undefined,
          auth,
        ),
      );
    let response = await requestUrl(credentials);
    if (credentials && response.status === 2)
      throw new MusicError('MUSIC_ACCOUNT_VERIFICATION_REQUIRED', 403);
    // Account rights determine the full source. If none is granted, use only
    // Kugou's anonymous preview flow, never an alternate hash/quality/provider.
    if (credentials && (response.status !== 1 || !response.url?.length))
      response = await requestUrl();
    if (credentials && !(await this.account!.isCurrent(credentials.id)))
      throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    if (response.status !== 1 || !response.url?.length || response.extName !== 'mp3')
      throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    const offset = response.hash_offset;
    const duration = offset?.end_ms
      ? offset.end_ms - (offset.start_ms ?? 0)
      : (response.timeLength ?? 0) * 1000;
    return {
      accountRevision,
      durationMs: integer(duration),
      offsetMs: offset?.end_ms ? integer(offset.start_ms) : 0,
      preview: Boolean(offset?.end_ms),
      url: kugouAssetUrl(response.url[0], 'audio'),
    };
  }

  async resolve(id: string, signal?: AbortSignal) {
    const [track, playback] = await Promise.all([
      this.track(id, signal),
      this.playback(id, signal),
    ]);
    return {
      offsetMs: playback.offsetMs,
      src: `/api/runtime/music/tracks/${encodeURIComponent(id)}/stream${this.account ? '?accountRevision=' + encodeURIComponent(playback.accountRevision) : ''}`,
      track: {
        ...track,
        durationMs: playback.durationMs,
        playbackKind: playback.preview ? ('preview' as const) : ('full' as const),
      },
    };
  }

  async cover(id: string, request: Request) {
    await this.track(id, request.signal);
    const cover = publicTracks.get(id)?.cover;
    if (!cover) throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    const response = await this.fetcher(cover, {
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
    });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !type || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
      await response.body?.cancel();
      throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
    }
    const bytes = await boundedBytes(response, 3 * 1024 * 1024);
    return new Response(bytes, {
      headers: {
        ...headers,
        'Cache-Control': 'private, max-age=300',
        'Content-Type': type,
        'Content-Length': String(bytes.byteLength),
      },
    });
  }

  async stream(id: string, request: Request) {
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(range))
      throw new MusicError('MUSIC_RANGE_INVALID', 416);
    const playback = await this.playback(
      id,
      request.signal,
      new URL(request.url).searchParams.get('accountRevision'),
    );
    const response = await this.fetcher(playback.url, {
      headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
    });
    if (
      this.account &&
      playback.accountRevision !== 'anonymous' &&
      !(await this.account.isCurrent(playback.accountRevision))
    ) {
      await response.body?.cancel();
      throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    }
    const resultHeaders = new Headers({
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'audio/mpeg',
    });
    const contentRange = response.headers.get('content-range');
    if (response.status === 416) {
      await response.body?.cancel();
      if (contentRange && /^bytes \*\/\d+$/u.test(contentRange))
        resultHeaders.set('Content-Range', contentRange);
      return new Response(null, { headers: resultHeaders, status: 416 });
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const encoding = response.headers.get('content-encoding');
    if (
      ![200, 206].includes(response.status) ||
      !contentType ||
      !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(contentType) ||
      (encoding && encoding !== 'identity') ||
      (response.status === 206 && (!contentRange || !/^bytes \d+-\d+\/\d+$/u.test(contentRange)))
    ) {
      await response.body?.cancel();
      throw new MusicError('MUSIC_SOURCE_UNAVAILABLE', 502);
    }
    for (const key of ['content-length', 'content-range', 'etag', 'last-modified']) {
      const value = response.headers.get(key);
      if (value) resultHeaders.set(key, value);
    }
    if (request.method === 'HEAD') await response.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : response.body, {
      headers: resultHeaders,
      status: response.status,
    });
  }
}
