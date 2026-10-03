// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as compositionModule from '@/server/runtime/presentation/default-composition';
import { AgentService } from '@/server/services/agent';

import { SystemCapabilityIdentifier } from '../../systemCapabilityManifest';
import type { ToolExecutionContext } from '../../types';
import { systemCapabilitiesRuntime } from '../systemCapabilities';
import { taskRuntime } from '../task';

vi.mock('../task', () => ({ taskRuntime: { factory: vi.fn() } }));

const context: ToolExecutionContext = {
  agentId: 'owned-agent',
  serverDB: {} as any,
  toolManifestMap: {},
  topicId: 'owned-topic',
  userId: 'owner',
};

afterEach(() => vi.restoreAllMocks());

describe('system capabilities authorization', () => {
  it('rejects missing authenticated scope before reading agent configuration', async () => {
    const read = vi.spyOn(AgentService.prototype, 'getAgentConfig');
    await expect(
      systemCapabilitiesRuntime.factory({ ...context, userId: undefined }),
    ).rejects.toThrow('Authenticated agent scope required');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an agent that has not enabled the capability bridge', async () => {
    vi.spyOn(AgentService.prototype, 'getAgentConfig').mockResolvedValue({ plugins: [] } as any);
    const assemble = vi.spyOn(compositionModule, 'getDefaultPresentationComposition');
    await expect(systemCapabilitiesRuntime.factory(context)).rejects.toThrow(
      'System capabilities are not enabled',
    );
    expect(assemble).not.toHaveBeenCalled();
  });

  it('builds the presentation port from the authenticated account and preserves task scope', async () => {
    vi.spyOn(AgentService.prototype, 'getAgentConfig').mockResolvedValue({
      plugins: [SystemCapabilityIdentifier],
    } as any);
    const portFactory = vi.fn().mockReturnValue({ listOperations: async () => ({ tools: [] }) });
    vi.spyOn(compositionModule, 'getDefaultPresentationComposition').mockReturnValue({
      composition: { generationPortFactory: portFactory } as any,
      error: undefined,
      readiness: undefined,
    });
    const tasks = vi.spyOn(taskRuntime, 'factory').mockReturnValue({
      createTask: vi.fn(),
      listTasks: vi.fn(),
    });
    const runtime = await systemCapabilitiesRuntime.factory(context);
    expect(tasks).toHaveBeenCalledWith(context);
    expect(portFactory).toHaveBeenCalledWith({
      userId: 'owner',
      sessionId: 'presentation-account:owner',
      request: expect.any(Request),
    });
    expect(JSON.parse((await runtime.catalog()).content).presentationReady).toBe(true);
  });
});
