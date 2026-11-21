import { MusicError } from './contracts';

/** Next dev can expose its internal port in request.url behind the SPA proxy. */
export function assertMusicRequestOrigin(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new MusicError('MUSIC_FORBIDDEN', 403);

  const origin = request.headers.get('origin');
  if (!origin) return;
  const url = new URL(request.url);
  if (origin === url.origin) return;

  // Host is the browser's actual request target. Forwarded headers alone must
  // never authorize a different origin, and a different port is still cross-origin.
  try {
    const source = new URL(origin);
    const host = request.headers.get('host');
    if (
      source.origin === origin &&
      source.protocol === url.protocol &&
      source.host === host?.toLowerCase()
    )
      return;
  } catch {
    // Opaque and malformed origins are rejected with the same bounded error.
  }
  throw new MusicError('MUSIC_FORBIDDEN', 403);
}
