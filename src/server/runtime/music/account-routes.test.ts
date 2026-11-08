// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { beforeEach, expect, it, vi } from 'vitest';

import { GET as cover } from '@/app/(backend)/api/runtime/music/account/playlists/[playlistId]/cover/route';
import { POST } from '@/app/(backend)/api/runtime/music/account/route';

import { createMusicAccountService } from './account-production';

vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (request: Request, auth: { userId: string; serverDB: object }) => Promise<Response>,
    ) =>
    (request: Request) =>
      request.headers.get('authorization') === 'alice'
        ? handler(request, { userId: 'alice', serverDB: {} })
        : Promise.resolve(new Response(null, { status: 401 })),
}));
vi.mock('./account-production', () => ({ createMusicAccountService: vi.fn() }));
const service = {
  status: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
  disconnect: vi.fn(),
  library: vi.fn(),
  playlist: vi.fn(),
  playlistCover: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  service.status.mockResolvedValue({ state: 'disconnected', revision: 'disconnected' });
  vi.mocked(createMusicAccountService).mockReturnValue(
    service as unknown as ReturnType<typeof createMusicAccountService>,
  );
});
const request = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://app.test/api/runtime/music/account', {
      method: 'POST',
      headers: { 'authorization': 'alice', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
it('authenticates every account action and forbids cross-site or forged-owner commands', async () => {
  expect((await request({ operation: 'status' }, { authorization: '' })).status).toBe(401);
  expect(createMusicAccountService).not.toHaveBeenCalled();
  expect((await request({ operation: 'start' }, { origin: 'https://other.test' })).status).toBe(
    403,
  );
  expect(
    (await request({ operation: 'disconnect' }, { 'sec-fetch-site': 'cross-site' })).status,
  ).toBe(403);
  expect((await request({ operation: 'status', userId: 'bob' })).status).toBe(400);
  expect((await request({ operation: 'poll', challengeId: 'not-an-id' })).status).toBe(400);
  expect(service.start).not.toHaveBeenCalled();
  expect(service.disconnect).not.toHaveBeenCalled();
  expect((await request({ operation: 'status' })).status).toBe(200);
  expect(createMusicAccountService).toHaveBeenLastCalledWith({}, 'alice');
});
it('bounds streamed bodies and sanitizes upstream and vault failures', async () => {
  expect((await request({ operation: 'status', extra: 'x'.repeat(4096) })).status).toBe(413);
  service.poll.mockRejectedValue(new Error('token=private-provider-token'));
  const response = await request({ operation: 'poll', challengeId: randomUUID() });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private-provider-token');
});
it('bounds personal library pages and rejects caller-supplied account identifiers or upstream locations', async () => {
  service.library.mockResolvedValue({ playlists: [], page: 1 });
  expect((await request({ operation: 'library' })).status).toBe(200);
  expect(service.library).toHaveBeenLastCalledWith(1, expect.any(AbortSignal));
  expect((await request({ operation: 'playlist', playlistId: '3', page: 2 })).status).toBe(200);
  expect(service.playlist).toHaveBeenLastCalledWith('3', 2, expect.any(AbortSignal));
  for (const body of [
    { operation: 'library', page: 0 },
    { operation: 'library', page: 51 },
    { operation: 'library', userId: 'other-owner' },
    { operation: 'playlist', playlistId: 'https://localhost/private' },
    { operation: 'playlist', playlistId: '3', token: 'forged-token' },
  ])
    expect((await request(body)).status).toBe(400);
});
it('authenticates collection covers and requires bounded IDs, revision and same-site requests', async () => {
  const revision = randomUUID();
  service.playlistCover.mockResolvedValue(new Response('image'));
  const get = (id = '3', headers: Record<string, string> = {}, query: string = revision) =>
    cover(
      new Request(
        `https://app.test/api/runtime/music/account/playlists/${id}/cover?revision=${query}`,
        {
          headers: { authorization: 'alice', ...headers },
        },
      ),
      { params: Promise.resolve({ playlistId: id }) },
    );
  expect((await get('3', { authorization: '' })).status).toBe(401);
  expect((await get('3', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await get('invalid')).status).toBe(400);
  expect((await get('3', {}, 'invalid')).status).toBe(400);
  expect(service.playlistCover).not.toHaveBeenCalled();
  expect((await get()).status).toBe(200);
  expect(service.playlistCover).toHaveBeenCalledWith('3', expect.any(Request));
  expect(createMusicAccountService).toHaveBeenLastCalledWith({}, 'alice');
});
it('accepts playlist pages beyond 50 without accepting unsafe, negative or fractional page numbers', async () => {
  expect((await request({ operation: 'playlist', playlistId: '3', page: 51 })).status).toBe(200);
  expect(service.playlist).toHaveBeenLastCalledWith('3', 51, expect.any(AbortSignal));
  expect(
    (await request({ operation: 'playlist', playlistId: '3', page: Number.MAX_SAFE_INTEGER }))
      .status,
  ).toBe(200);
  service.playlist.mockClear();
  for (const page of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect((await request({ operation: 'playlist', playlistId: '3', page })).status).toBe(400);
  expect(service.playlist).not.toHaveBeenCalled();
  expect((await request({ operation: 'library', page: 51 })).status).toBe(400);
});
