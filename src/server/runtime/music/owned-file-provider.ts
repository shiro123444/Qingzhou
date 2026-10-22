import { randomUUID } from 'node:crypto';

import type { MusicTrack } from '@/types/music';

import {
  MusicError,
  type MusicFile,
  type MusicFiles,
  type MusicProvider,
  type MusicStorage,
} from './contracts';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/** Single byte ranges only. Normalize before sending to storage; never buffer the media. */
export function musicByteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  const invalid = () => {
    throw new MusicError('MUSIC_RANGE_INVALID', 416);
  };
  if (!match || (!match[1] && !match[2]) || size < 1) return invalid();
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ([first, last].some((n) => n !== undefined && !Number.isSafeInteger(n))) return invalid();
  if (first === undefined) {
    if (!last) return invalid();
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return invalid();
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

export class OwnedFileMusicProvider implements MusicProvider {
  constructor(
    readonly userId: string,
    private files: MusicFiles,
    private storage: MusicStorage,
    private fetcher: typeof fetch = fetch,
  ) {}

  private assertFile(file: MusicFile | undefined): MusicFile {
    if (!file || file.userId !== this.userId || !/^audio\/[a-z\d.+-]+$/iu.test(file.fileType))
      throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    return file;
  }

  private dto(file: MusicFile): MusicTrack {
    return {
      id: file.id,
      mimeType: file.fileType,
      name: file.name,
      size: file.size,
      source: 'library',
      version: file.updatedAt.toISOString(),
    };
  }

  async search(query: string, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const rows = await this.files.queryAudio({ query, limit });
    signal?.throwIfAborted();
    return rows.map((row) => this.dto(this.assertFile(row)));
  }

  async track(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const file = this.assertFile(await this.files.findById(id));
    signal?.throwIfAborted();
    return this.dto(file);
  }

  async resolve(id: string, signal?: AbortSignal) {
    const track = await this.track(id, signal);
    return {
      track,
      src: `/api/runtime/music/tracks/${encodeURIComponent(id)}/stream?requestId=${randomUUID()}`,
    };
  }

  async stream(id: string, request: Request): Promise<Response> {
    request.signal.throwIfAborted();
    const file = this.assertFile(await this.files.findById(id));
    let metadata: Awaited<ReturnType<MusicStorage['getFileMetadata']>>;
    try {
      metadata = await this.storage.getFileMetadata(file.url);
    } catch (error) {
      request.signal.throwIfAborted();
      const missing =
        (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
      throw new MusicError(
        missing ? 'MUSIC_TRACK_UNAVAILABLE' : 'MUSIC_STORAGE_UNAVAILABLE',
        missing ? 404 : 502,
      );
    }
    request.signal.throwIfAborted();
    const size = metadata.contentLength;
    if (!Number.isSafeInteger(size) || size < 0)
      throw new MusicError('MUSIC_STORAGE_UNAVAILABLE', 502);
    if (request.method === 'HEAD')
      return new Response(null, {
        headers: {
          ...headers,
          'Accept-Ranges': 'bytes',
          'Content-Type': file.fileType,
          'Content-Length': String(size),
        },
      });
    let range: ReturnType<typeof musicByteRange> | undefined;
    try {
      const raw = request.headers.get('range');
      range = raw ? musicByteRange(raw, size) : undefined;
    } catch (error) {
      if (error instanceof MusicError && error.status === 416)
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${size}` },
        });
      throw error;
    }
    const upstreamHeaders = new Headers();
    if (range) upstreamHeaders.set('Range', `bytes=${range.start}-${range.end}`);
    const ifRange = request.headers.get('if-range');
    if (range && ifRange) upstreamHeaders.set('If-Range', ifRange);
    // A cached/expired signature is renewed once, without changing range or retrying account auth.
    for (let attempt = 0; attempt < 2; attempt++) {
      request.signal.throwIfAborted();
      const url = await this.storage.createPreSignedUrlForPreview(file.url, 300);
      if (!['http:', 'https:'].includes(new URL(url).protocol))
        throw new MusicError('MUSIC_STORAGE_UNAVAILABLE', 502);
      const response = await this.fetcher(url, {
        headers: upstreamHeaders,
        method: request.method,
        redirect: 'error',
        cache: 'no-store',
        signal: request.signal,
      });
      if ([401, 403].includes(response.status) && attempt === 0) {
        await response.body?.cancel();
        continue;
      }
      const partial = response.status === 206;
      const contentRange = range ? `bytes ${range.start}-${range.end}/${size}` : undefined;
      const expectedLength = partial && range ? range.end - range.start + 1 : size;
      const valid =
        (partial && range && response.headers.get('content-range') === contentRange) ||
        (response.status === 200 && (!range || ifRange));
      const length = response.headers.get('content-length');
      if (
        !valid ||
        !response.body ||
        (response.headers.get('content-encoding') &&
          response.headers.get('content-encoding') !== 'identity') ||
        (length !== null && Number(length) !== expectedLength)
      ) {
        await response.body?.cancel();
        throw new MusicError(
          response.status === 404 ? 'MUSIC_TRACK_UNAVAILABLE' : 'MUSIC_STORAGE_UNAVAILABLE',
          response.status === 404 ? 404 : 502,
        );
      }
      const resultHeaders = new Headers({
        ...headers,
        'Accept-Ranges': 'bytes',
        'Content-Type': file.fileType,
        'Content-Length': String(expectedLength),
        'Referrer-Policy': 'no-referrer',
      });
      if (partial && contentRange) resultHeaders.set('Content-Range', contentRange);
      for (const key of ['etag', 'last-modified']) {
        const value = response.headers.get(key);
        if (value) resultHeaders.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    }
    throw new MusicError('MUSIC_STORAGE_UNAVAILABLE', 502);
  }
}
