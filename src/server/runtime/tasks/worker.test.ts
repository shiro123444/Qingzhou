// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import type { NativeAgentJob } from '@/database/schemas/agentRuntime';

import type { NativeAgentStore } from './store';
import { NativeAgentWorker } from './worker';

afterEach(() => vi.restoreAllMocks());

it('counts ownership from before claiming, so a delayed response cannot extend its lease', async () => {
  const startedAt = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
  const finish = vi.fn().mockResolvedValue(true);
  const dispatch = vi.fn().mockResolvedValue(true);
  const claim = vi
    .fn()
    .mockImplementationOnce(async () => {
      clock.mockReturnValue(startedAt + 60_001);
      return { id: 'job', operationId: 'op', stepIndex: 0, leaseOwner: 'owner' } as NativeAgentJob;
    })
    .mockResolvedValue(null);
  const store = {
    claim,
    dispatch,
    finish,
    recover: vi.fn(),
    renewJob: vi.fn(),
  } as unknown as NativeAgentStore;
  const execute = vi.fn();
  await new NativeAgentWorker(store, execute).tick();
  expect(dispatch).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith({ id: 'job', owner: 'owner' }, 'queued');
});
