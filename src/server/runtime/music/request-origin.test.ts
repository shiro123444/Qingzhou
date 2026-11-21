// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { assertMusicRequestOrigin } from './request-origin';

describe('music request origin', () => {
  it.each<[string, Record<string, string>]>([
    ['https://app.test/api/runtime/music', { origin: 'https://app.test' }],
    [
      'http://localhost:3010/api/runtime/music',
      { host: 'localhost:9876', origin: 'http://localhost:9876' },
    ],
    [
      'http://localhost:3010/api/runtime/music',
      { host: 'localhost:3012', origin: 'http://localhost:3012' },
    ],
    ['https://internal.test/api/runtime/music', { host: 'app.test', origin: 'https://app.test' }],
    ['https://app.test/api/runtime/music', {}],
  ])('accepts direct or proxy-preserved browser targets at %s', (url, headers) => {
    expect(() => assertMusicRequestOrigin(new Request(url, { headers }))).not.toThrow();
  });

  it.each<Record<string, string>>([
    { host: 'localhost:9876', origin: 'https://evil.test' },
    { host: 'localhost:9876', origin: 'http://localhost:9877' },
    { host: 'localhost:9876', origin: 'https://localhost:9876' },
    { host: 'localhost:9876', origin: 'null' },
    { host: 'localhost:9876', origin: 'malformed' },
    { host: 'localhost:9876', origin: 'http://user@localhost:9876' },
    { host: 'localhost:9876', origin: 'http://localhost:9876/path' },
    { 'host': 'localhost:9876', 'origin': 'http://localhost:9876', 'sec-fetch-site': 'cross-site' },
    {
      'host': 'localhost:9876',
      'origin': 'https://evil.test',
      'x-forwarded-host': 'evil.test',
      'x-forwarded-proto': 'https',
    },
    { 'origin': 'http://localhost:9876', 'x-forwarded-host': 'localhost:9876' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects cross-origin or forged proxy headers %j', (headers) => {
    expect(() =>
      assertMusicRequestOrigin(new Request('http://localhost:3010/api/runtime/music', { headers })),
    ).toThrow(expect.objectContaining({ code: 'MUSIC_FORBIDDEN', status: 403 }));
  });
});
