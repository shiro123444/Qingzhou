import { z } from 'zod';

import type { AtomicRuntime } from '../atomic-runtime';
import { MusicError, type MusicProvider } from './contracts';

const responseHeaders = { 'Cache-Control': 'private, no-store' };
const envelope = z
  .object({
    operation: z.enum([
      'music.search',
      'music.track.get',
      'music.playback.resolve',
      'skills.catalog',
    ]),
    input: z.unknown(),
  })
  .strict();

/** Consume bounded bytes, including chunked requests without Content-Length. */
async function readCommand(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new MusicError('MUSIC_INVALID', 400);
  const limit = 16_384;
  if (Number(request.headers.get('content-length')) > limit)
    throw new MusicError('MUSIC_LIMIT', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new MusicError('MUSIC_INVALID', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // checkAuth clones requests. Awaiting cancellation of one tee branch can
        // wait forever for the original branch, which the middleware does not read.
        void reader.cancel().catch(() => undefined);
        throw new MusicError('MUSIC_LIMIT', 413);
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
  return envelope.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function musicErrorResponse(error: unknown, request: Request) {
  const cancelled = request.signal.aborted;
  const invalid =
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    (error as { code?: string })?.code === 'PRESENTATION_INVALID';
  const code = cancelled
    ? 'MUSIC_CANCELLED'
    : error instanceof MusicError
      ? error.code
      : invalid
        ? 'MUSIC_INVALID'
        : 'MUSIC_STORAGE_UNAVAILABLE';
  const status = cancelled ? 499 : error instanceof MusicError ? error.status : invalid ? 400 : 502;
  return Response.json({ success: false, code }, { status, headers: responseHeaders });
}

export async function handleMusicCommand(
  request: Request,
  provider: MusicProvider,
  runtime: AtomicRuntime,
) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin)
      throw new MusicError('MUSIC_FORBIDDEN', 403);
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      throw new MusicError('MUSIC_FORBIDDEN', 403);
    const { operation, input } = await readCommand(request);
    const result = await runtime.invoke(operation, input, {
      scope: { userId: provider.userId, sessionId: `music-account:${provider.userId}` },
      services: { music: provider },
      signal: request.signal,
    });
    return Response.json({ success: true, result }, { headers: responseHeaders });
  } catch (error) {
    return musicErrorResponse(error, request);
  }
}

export async function handleMusicStream(request: Request, id: string, provider: MusicProvider) {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      throw new MusicError('MUSIC_FORBIDDEN', 403);
    z.string().min(1).max(200).parse(id);
    return await provider.stream(id, request);
  } catch (error) {
    return musicErrorResponse(error, request);
  }
}
