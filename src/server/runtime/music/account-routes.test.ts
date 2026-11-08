// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { beforeEach, expect, it, vi } from 'vitest';

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
