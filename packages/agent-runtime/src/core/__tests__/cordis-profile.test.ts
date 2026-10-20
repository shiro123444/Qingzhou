import { describe, expect, it, vi } from 'vitest';

import type { Agent, AgentInstruction, InstructionExecutor } from '../../types';
import { AgentRuntime } from '../runtime';

describe('agent profile production assembly', () => {
  it('replaces an executor by profile ID and installs a native request hook', async () => {
    const original: InstructionExecutor = vi.fn(async (_, state) => ({
      events: [],
      newState: state,
    }));
    const replacement: InstructionExecutor = vi.fn(async (_, state) => ({
      events: [],
      newState: state,
    }));
    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }),
    };
    const runtime = new AgentRuntime(agent, {
      composition: {
        bundles: { hooks: { entries: [{ id: 'hook', use: 'hook' }] } },
        modules: {
          'custom.finish': {
            plugin: (ctx) => {
              ctx.provide('qingzhou.agent.executor.finish', replacement);
            },
          },
          'hook': {
            plugin: (ctx) => {
              ctx.on('qingzhou.agent.plan', async (request, next) => {
                request.state.metadata = { ...request.state.metadata, profileHook: true };
                return next();
              });
            },
          },
        },
        profile: {
          bundles: ['agent', 'hooks'],
          patches: [{ entry: { id: 'executor.finish', use: 'custom.finish' }, op: 'replace' }],
        },
      },
      executors: { finish: original },
    });
    try {
      await runtime.step(AgentRuntime.createInitialState({ operationId: 'profile-test' }), {
        phase: 'init',
      });
      expect(original).not.toHaveBeenCalled();
      expect(replacement).toHaveBeenCalledOnce();
      expect(vi.mocked(replacement).mock.calls[0][1].metadata?.profileHook).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
