// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { ComputerError } from '@/server/runtime/computer/provider';
import { AgentComputerService } from '@/server/services/agentComputer';

import { agentComputerRouter } from './agentComputer';

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));
const factory = createCallerFactory(agentComputerRouter);
beforeEach(() => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '0');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const input = {
  agentId: 'agent',
  expectedRevision: 0,
  requestId: '2bb7bfa3-9d25-4a22-8a29-8b92dca360ed',
  command: { kind: 'ensure' as const },
};

it('authenticates management and refuses actor, ownership, provider and shell inputs', async () => {
  const get = vi
    .spyOn(AgentComputerService.prototype, 'get')
    .mockResolvedValue({ enabled: false, commands: [] });
  const manage = vi
    .spyOn(AgentComputerService.prototype, 'manage')
    .mockResolvedValue({ enabled: true, commands: [] });
  const anonymous = factory(await createContextInner());
  await expect(anonymous.get({ agentId: 'agent' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(anonymous.manage(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(
    anonymous.reconcile({ agentId: 'agent', commandId: input.requestId }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  const caller = factory(await createContextInner({ userId: 'owner' }));
  for (const bad of [
    { ...input, actor: 'agent' },
    { ...input, userId: 'another-owner' },
    { ...input, provider: 'arbitrary' },
    { ...input, command: { kind: 'shell', command: 'send secrets' } },
    { ...input, expectedRevision: -1 },
    { ...input, command: { kind: 'control', target: 'human', endpoint: 'https://evil.example' } },
  ]) {
    await expect(caller.manage(bad as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
  expect(manage).not.toHaveBeenCalled();
  await expect(
    caller.reconcile({
      agentId: 'agent',
      commandId: input.requestId,
      resourceId: 'forged',
    } as never),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await caller.manage(input);
  await caller.get({ agentId: 'agent' });
  expect(manage).toHaveBeenCalledWith(input);
  expect(get).toHaveBeenCalledWith('agent');
});

it('maps scope and state errors without exposing provider exceptions and gates the runtime mode', async () => {
  const get = vi
    .spyOn(AgentComputerService.prototype, 'get')
    .mockRejectedValue(new ComputerError('NOT_FOUND'));
  const caller = factory(await createContextInner({ userId: 'owner' }));
  await expect(caller.get({ agentId: 'foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  get.mockRejectedValue(new ComputerError('DISABLED'));
  await expect(caller.get({ agentId: 'agent' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  const manage = vi
    .spyOn(AgentComputerService.prototype, 'manage')
    .mockRejectedValue(new ComputerError('BUSY'));
  await expect(caller.manage(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  vi.stubEnv('AGENT_RUNTIME_MODE', 'local');
  await expect(caller.manage(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(manage).toHaveBeenCalledOnce();
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  get.mockRejectedValue(new Error('private provider token'));
  await expect(caller.get({ agentId: 'agent' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'COMPUTER_UNAVAILABLE',
  });
});
