import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { MAX_MUSIC_LYRICS_BYTES, type MusicLyrics } from '@/types/music';

import { MusicError } from './contracts';

// Public hash-based LRC protocol used by MoeKoeMusic/KuGouMusicApi (MIT notice in docs).
// Access keys are obtained from the upstream search response and never sent to the browser.
const candidateSchema = z.object({
  accesskey: z.string().min(1).max(512),
  id: z.union([z.string().regex(/^\d{1,20}$/u), z.number().int().nonnegative()]),
});
const searchSchema = z.object({
  status: z.number(),
  candidates: z.array(z.unknown()).max(100).optional(),
});
const contentSchema = z.object({ status: z.number(), content: z.string().optional() });

export class KugouLyricsSource {
  private readonly cache = new Map<string, { expires: number; result: MusicLyrics }>();
  private readonly device = randomBytes(16).toString('hex');

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(
    path: '/v1/search' | '/download',
    params: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const url = new URL(path, 'https://lyrics.kugou.com');
    const salt = 'OIlwieks28dk2k092lksi2UIkp';
    const signature = createHash('md5')
      .update(
        salt +
          Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('') +
          salt,
      )
      .digest('hex');
    url.search = new URLSearchParams({ ...params, signature }).toString();
    const response = await this.fetcher(url.href, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'dfid': '-',
        'mid': this.device,
        'kg-rc': '1',
        'kg-thash': '5d816a0',
        'kg-rec': '1',
        'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
      },
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12_000)]),
    });
    const limit = 512 * 1024;
    if (
      !response.ok ||
      response.headers.has('ssa-code') ||
      Number(response.headers.get('content-length')) > limit
    ) {
      await response.body?.cancel();
      throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async get(trackId: string, signal?: AbortSignal): Promise<MusicLyrics> {
    signal?.throwIfAborted();
    const parsed = /^kugou:([a-f\d]{32}):\d{1,16}:(\d{1,16})$/u.exec(trackId);
    if (!parsed) throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    const cached = this.cache.get(trackId);
    if (cached && cached.expires > Date.now()) return cached.result;
    try {
      const search = searchSchema.parse(
        await this.request(
          '/v1/search',
          {
            album_audio_id: parsed[2],
            appid: '1005',
            clientver: '20489',
            duration: '0',
            hash: parsed[1],
            keyword: '',
            lrctxt: '1',
            man: 'no',
          },
          signal,
        ),
      );
      if (search.status !== 200) throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
      const candidate = search.candidates
        ?.map((item) => candidateSchema.safeParse(item))
        .find((item) => item.success)?.data;
      let text: string | null = null;
      if (candidate) {
        const lyric = contentSchema.parse(
          await this.request(
            '/download',
            {
              ver: '1',
              client: 'android',
              id: String(candidate.id),
              accesskey: candidate.accesskey,
              fmt: 'lrc',
              charset: 'utf8',
            },
            signal,
          ),
        );
        if (lyric.status !== 200) throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
        if (lyric.content) {
          if (!/^[a-z\d+/=\r\n]+$/iu.test(lyric.content))
            throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
          const bytes = Buffer.from(lyric.content, 'base64');
          if (bytes.length > MAX_MUSIC_LYRICS_BYTES)
            throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
          const decoded = new TextDecoder('utf-8', { fatal: true })
            .decode(bytes)
            .replace(/^\uFEFF/u, '')
            .trim();
          // Only the exact track's timed lyrics; do not silently substitute title-search matches.
          if (/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/u.test(decoded)) text = decoded;
        }
      }
      signal?.throwIfAborted();
      const result: MusicLyrics = { format: 'lrc', text, trackId };
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(trackId, { expires: Date.now() + (text ? 600_000 : 60_000), result });
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MusicError) throw error;
      throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
    }
  }
}

export const kugouLyricsSource = new KugouLyricsSource();
