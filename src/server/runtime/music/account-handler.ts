import { z } from 'zod';

import type { MusicAccountService } from './account-service';
import { MusicError } from './contracts';

const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.enum(['status', 'start', 'disconnect']) }).strict(),
  z.object({ challengeId: z.string().uuid(), operation: z.enum(['poll', 'cancel']) }).strict(),
  z
    .object({ operation: z.literal('library'), page: z.number().int().min(1).max(50).default(1) })
    .strict(),
  z
    .object({
      operation: z.literal('playlist'),
      page: z.number().int().positive().safe().default(1),
      playlistId: z.string().regex(/^\d{1,20}$/u),
    })
    .strict(),
]);
const headers = { 'Cache-Control': 'private, no-store' };
export function accountErrorResponse(error: unknown, request: Request) {
  const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
  const status = request.signal.aborted
    ? 499
    : error instanceof MusicError
      ? error.status
      : invalid
        ? 400
        : 503;
  const code = request.signal.aborted
    ? 'MUSIC_CANCELLED'
    : error instanceof MusicError
      ? error.code
      : invalid
        ? 'MUSIC_INVALID'
        : 'MUSIC_ACCOUNT_UNAVAILABLE';
  return Response.json({ success: false, code }, { headers, status });
}
export async function handleMusicAccount(request: Request, service: MusicAccountService) {
  try {
    const origin = request.headers.get('origin');
    if (
      (origin && origin !== new URL(request.url).origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new MusicError('MUSIC_FORBIDDEN', 403);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      throw new MusicError('MUSIC_INVALID', 400);
    if (Number(request.headers.get('content-length')) > 2048)
      throw new MusicError('MUSIC_LIMIT', 413);
    const reader = request.body?.getReader();
    if (!reader) throw new MusicError('MUSIC_INVALID', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
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
    const input = command.parse(JSON.parse(new TextDecoder().decode(bytes)));
    request.signal.throwIfAborted();
    const result =
      input.operation === 'status'
        ? await service.status()
        : input.operation === 'start'
          ? await service.start(request.signal)
          : input.operation === 'poll'
            ? await service.poll(input.challengeId, request.signal)
            : input.operation === 'cancel'
              ? await service.cancel(input.challengeId)
              : input.operation === 'library'
                ? await service.library(input.page, request.signal)
                : input.operation === 'playlist'
                  ? await service.playlist(input.playlistId, input.page, request.signal)
                  : await service.disconnect();
    return Response.json({ result, success: true }, { headers });
  } catch (error) {
    return accountErrorResponse(error, request);
  }
}
