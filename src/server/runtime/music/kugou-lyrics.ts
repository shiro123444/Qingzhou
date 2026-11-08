import { createHash, randomBytes } from 'node:crypto';
import { createInflate } from 'node:zlib';

import { z } from 'zod';

import { MAX_MUSIC_LYRICS_BYTES, type MusicLyrics } from '@/types/music';

import { MusicError } from './contracts';

// Public hash-based lyric protocol used by MoeKoeMusic/KuGouMusicApi (MIT notice in docs).
// Access keys are obtained from the upstream search response and never sent to the browser.
const candidateSchema = z.object({
  accesskey: z.string().min(1).max(512),
  id: z.union([z.string().regex(/^\d{1,20}$/u), z.number().int().nonnegative()]),
});
const searchSchema = z.object({
  status: z.number(),
  candidates: z.array(z.unknown()).max(100).optional(),
});
const contentSchema = z.object({
  status: z.number(),
  content: z.string().optional(),
  contenttype: z.number().int().nonnegative().optional(),
});
const MAX_TIMESTAMP_MS = 24 * 60 * 60 * 1000;
// Published KRC wire-format key, not an account credential or content entitlement.
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
const unavailable = () => new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);

function decodeBase64(content: string) {
  const encoded = content.replaceAll(/[\r\n]/gu, '');
  if (
    encoded.length > Math.ceil(MAX_MUSIC_LYRICS_BYTES / 3) * 4 + 8 ||
    !/^[a-z\d+/]*={0,2}$/iu.test(encoded) ||
    encoded.length % 4 === 1
  )
    throw unavailable();
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length > MAX_MUSIC_LYRICS_BYTES ||
    bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  )
    throw unavailable();
  return bytes;
}
const decodeText = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/u, '')
    .trim();

async function decodeKrc(bytes: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (bytes.subarray(0, 4).toString('ascii') !== 'krc1') throw unavailable();
  const compressed = Buffer.from(bytes.subarray(4));
  for (let index = 0; index < compressed.length; index++)
    compressed[index] ^= KRC_KEY[index % KRC_KEY.length];
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    let length = 0;
    const abort = () => inflater.destroy(new DOMException('Aborted', 'AbortError'));
    inflater.once('error', reject);
    inflater.once('close', () => signal?.removeEventListener('abort', abort));
    inflater.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_MUSIC_LYRICS_BYTES) inflater.destroy(unavailable());
      else chunks.push(chunk);
    });
    inflater.once('end', () => resolve(Buffer.concat(chunks, length)));
    signal?.addEventListener('abort', abort, { once: true });
    inflater.end(compressed);
  });
  signal?.throwIfAborted();
  return decodeText(decoded);
}

function validateKrc(text: string) {
  let previousLine = -1;
  let count = 0;
  for (const line of text.split(/\r?\n/u)) {
    const offset = /^\[offset:(-?\d+)\]$/u.exec(line);
    if (line.startsWith('[offset:') && !offset) throw unavailable();
    if (offset && Math.abs(Number(offset[1])) > MAX_TIMESTAMP_MS) throw unavailable();
    const match = /^\[(\d+),(\d+)\](.*)$/u.exec(line);
    if (!match) {
      if (/^\[[-\d]/u.test(line)) throw unavailable();
      continue;
    }
    const start = Number(match[1]);
    const duration = Number(match[2]);
    if (start < previousLine || start + duration > MAX_TIMESTAMP_MS) throw unavailable();
    previousLine = start;
    count++;
    let previousWord = -1;
    for (const word of match[3].matchAll(/<(\d+),(\d+),(\d+)>/gu)) {
      const offset = Number(word[1]);
      const length = Number(word[2]);
      if (offset < previousWord || offset + length > duration) throw unavailable();
      previousWord = offset;
    }
    // Reject malformed timing tags instead of deriving fake word durations.
    if (/<-?\d+,/u.test(match[3].replaceAll(/<\d+,\d+,\d+>/gu, ''))) throw unavailable();
  }
  return count > 0;
}
const isLrc = (text: string) => /\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/u.test(text);

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
    const boundedSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30_000),
    ]);
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
          boundedSignal,
        ),
      );
      if (search.status !== 200) throw new MusicError('MUSIC_LYRICS_UNAVAILABLE', 502);
      const candidate = search.candidates
        ?.map((item) => candidateSchema.safeParse(item))
        .find((item) => item.success)?.data;
      let text: string | null = null;
      let format: MusicLyrics['format'] = 'lrc';
      if (candidate) {
        const download = async (fmt: 'krc' | 'lrc') =>
          contentSchema.parse(
            await this.request(
              '/download',
              {
                ver: '1',
                client: 'android',
                id: String(candidate.id),
                accesskey: candidate.accesskey,
                fmt,
                charset: 'utf8',
              },
              boundedSignal,
            ),
          );
        const lyric = await download('krc');
        if (lyric.status !== 200 && lyric.status !== 404) throw unavailable();
        if (lyric.status === 200 && lyric.content) {
          const bytes = decodeBase64(lyric.content);
          if (bytes.subarray(0, 4).toString('ascii') === 'krc1') {
            const decoded = await decodeKrc(bytes, boundedSignal);
            if (validateKrc(decoded)) {
              text = decoded;
              format = 'krc';
            }
          } else {
            if (lyric.contenttype === 0) throw unavailable();
            const decoded = decodeText(bytes);
            // Some recordings answer a KRC request with their existing LRC.
            if (!isLrc(decoded)) throw unavailable();
            text = decoded;
          }
        }
        if (!text) {
          const fallback = await download('lrc');
          if (fallback.status !== 200 && fallback.status !== 404) throw unavailable();
          if (fallback.status === 200 && fallback.content) {
            const decoded = decodeText(decodeBase64(fallback.content));
            if (isLrc(decoded)) text = decoded;
          }
        }
      }
      boundedSignal.throwIfAborted();
      const result: MusicLyrics = { format, text, trackId };
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
