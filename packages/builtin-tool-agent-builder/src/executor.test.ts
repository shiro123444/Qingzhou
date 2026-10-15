import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ initialized: false, constructions: 0, imports: 0 }));

vi.mock('@lobechat/agent-manager-runtime', () => {
  state.imports++;
  return {
    AgentManagerRuntime: class {
      constructor() {
        if (!state.initialized) throw new ReferenceError('Runtime module is still initializing');
        state.constructions++;
      }

      getAvailableModels = async () => ({ content: 'models', success: true });
    },
  };
});
vi.mock('@/services/agent', () => ({ agentService: {} }));
vi.mock('@/services/discover', () => ({ discoverService: {} }));

describe('agent builder initialization', () => {
  it('loads during the runtime import cycle and constructs once on first dispatch', async () => {
    const { agentBuilderExecutor } = await import('./executor');
    expect(state.imports).toBe(0);
    expect(state.constructions).toBe(0);

    state.initialized = true;
    await expect(agentBuilderExecutor.getAvailableModels({})).resolves.toEqual({
      content: 'models',
      success: true,
    });
    await agentBuilderExecutor.getAvailableModels({});
    expect(state.constructions).toBe(1);
    expect(state.imports).toBe(1);
  });
});
