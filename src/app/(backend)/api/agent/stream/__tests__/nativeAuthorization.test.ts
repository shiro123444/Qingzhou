// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { GET } from '../route';

const mocks = vi.hoisted(() => ({
  userId: 'alice' as string | undefined,
  checkpoint: vi.fn(),
  createStream: vi.fn(),
}));
vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth: (handler: any) => async (request: Request) => {
    if (!mocks.userId) return new Response(null, { status: 401 });
    return handler(request, { userId: mocks.userId, serverDB: {} });
  },
}));
vi.mock('@/server/runtime/tasks/store', () => ({
  NativeAgentStore: class {
    checkpoint = mocks.checkpoint;
  },
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  createStreamEventManager: mocks.createStream,
}));
beforeEach(() => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  vi.clearAllMocks();
  mocks.userId = 'alice';
  mocks.createStream.mockReturnValue({
    subscribeStreamEvents: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new NextRequest('https://test.invalid/api/agent/stream?operationId=op');

it('requires authentication before reading a durable operation or stream', async () => {
  mocks.userId = undefined;
  expect((await GET(request())).status).toBe(401);
  expect(mocks.checkpoint).not.toHaveBeenCalled();
  expect(mocks.createStream).not.toHaveBeenCalled();
});
it('does not open another account stream or expose whether the operation exists', async () => {
  for (const checkpoint of [{ userId: 'bob' }, undefined]) {
    mocks.checkpoint.mockResolvedValue(checkpoint);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Operation not found' });
  }
  expect(mocks.createStream).not.toHaveBeenCalled();
});
it('opens the existing event transport for the authenticated owner', async () => {
  mocks.checkpoint.mockResolvedValue({ userId: 'alice' });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(mocks.checkpoint).toHaveBeenCalledWith('op');
  await response.body?.cancel();
});
