// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/(backend)/api/runtime/music/route';
import { GET, HEAD } from '@/app/(backend)/api/runtime/music/tracks/[id]/stream/route';

import type { MusicProvider } from './contracts';
import { createMusicProvider } from './production';
import { getMusicRuntime } from './runtime';

// Auth itself has dedicated tests; this boundary verifies neither route bypasses its wrapper.
vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (request: Request, auth: { userId: string; serverDB: object }) => Promise<Response>,
    ) =>
    async (request: Request) =>
      request.headers.get('authorization') === 'test-alice'
        ? handler(request, { userId: 'alice', serverDB: {} })
        : new Response(null, { status: 401 }),
}));
vi.mock('./production', () => ({ createMusicProvider: vi.fn() }));

let provider: MusicProvider;
beforeEach(() => {
  provider = {
    userId: 'alice',
    search: vi.fn().mockResolvedValue([]),
    track: vi.fn(),
    resolve: vi.fn(),
    stream: vi.fn().mockImplementation(
      async (_id: string, request: Request) =>
        new Response(request.method === 'HEAD' ? null : 'audio', {
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
    ),
  };
  vi.mocked(createMusicProvider)
    .mockReset()
    .mockReturnValue(provider as ReturnType<typeof createMusicProvider>);
});
afterAll(async () => {
  await getMusicRuntime().dispose();
});

describe('authenticated music routes', () => {
  it('rejects anonymous commands and media before constructing account services', async () => {
    expect(
      (
        await POST(new Request('https://app.test', { method: 'POST' }), {
          params: Promise.resolve({}),
        })
      ).status,
    ).toBe(401);
    expect(
      (await GET(new Request('https://app.test'), { params: Promise.resolve({ id: 'one' }) }))
        .status,
    ).toBe(401);
    expect(createMusicProvider).not.toHaveBeenCalled();
  });
  it('injects the authenticated account into the real music runtime', async () => {
    const response = await POST(
      new Request('https://app.test/api/runtime/music', {
        method: 'POST',
        headers: { 'authorization': 'test-alice', 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'music.search', input: {} }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(200);
    expect(createMusicProvider).toHaveBeenCalledWith({}, 'alice');
    expect(provider.search).toHaveBeenCalledWith('', 20, expect.any(AbortSignal));
  });
  it('reads promised route params and preserves HEAD and Range', async () => {
    const request = new Request('https://app.test/api/runtime/music/tracks/one/stream', {
      method: 'HEAD',
      headers: { authorization: 'test-alice', Range: 'bytes=1-2' },
    });
    const response = await HEAD(request, { params: Promise.resolve({ id: 'one' }) });
    expect(response.body).toBeNull();
    expect(provider.stream).toHaveBeenCalledWith('one', request);
  });
  it('sanitizes production service initialization errors', async () => {
    vi.mocked(createMusicProvider).mockImplementation(() => {
      throw new Error('private database password');
    });
    const response = await GET(
      new Request('https://app.test', { headers: { authorization: 'test-alice' } }),
      { params: Promise.resolve({ id: 'one' }) },
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('password');
  });
});
