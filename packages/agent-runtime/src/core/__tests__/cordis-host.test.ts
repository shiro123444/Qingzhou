import { Context } from '@lobechat/cordis-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Agent,
  AgentInstruction,
  AgentRuntimeContext,
  AgentState,
  InstructionExecutor,
} from '../../types';
import { CordisAgentHost } from '../cordis-host';
import { AgentRuntime } from '../runtime';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const createMockState = (overrides?: Partial<AgentState>): AgentState =>
  AgentRuntime.createInitialState({ operationId: 'test', ...overrides });

const createMockContext = (overrides?: Partial<AgentRuntimeContext>): AgentRuntimeContext => ({
  phase: 'init',
  ...overrides,
});

describe('CordisAgentHost', () => {
  const trackedHosts: CordisAgentHost[] = [];

  const createHost = (
    agent: Agent,
    executors?: Partial<Record<AgentInstruction['type'], InstructionExecutor>>,
  ): CordisAgentHost => {
    const host = new CordisAgentHost(agent, executors);
    trackedHosts.push(host);
    return host;
  };

  afterEach(async () => {
    while (trackedHosts.length > 0) {
      const host = trackedHosts.pop();
      if (host) {
        try {
          await host.dispose();
        } catch {
          // Disposal errors during afterEach cleanup are ignored
        }
      }
    }
  });

  it('[1] mounts onto real upstream Cordis context with native services and default execution', async () => {
    const defaultLlmInstruction: AgentInstruction = {
      payload: { messages: [], model: 'gpt-4o', provider: 'openai', tools: [] },
      type: 'call_llm',
    };
    const runner: Agent['runner'] = vi.fn().mockResolvedValue(defaultLlmInstruction);
    const agent: Agent = { runner };
    const callToolExecutor: InstructionExecutor = vi.fn().mockResolvedValue({
      events: [],
      newState: createMockState({ status: 'running' }),
    });

    const host = createHost(agent, {
      call_tool: callToolExecutor,
    });

    expect(Context.is(host.native)).toBe(true);

    await host.ready();

    expect(host.native.get('qingzhou.agent.runner')).toBe(runner);
    expect(host.hasExecutor('call_tool')).toBe(true);
    expect(host.hasExecutor('finish')).toBe(false);

    const context = createMockContext({ phase: 'user_input' });
    const state = createMockState();

    const planResult = await host.plan(context, state);
    expect(planResult).toEqual(defaultLlmInstruction);
    expect(runner).toHaveBeenCalledWith(context, state);

    const instruction: AgentInstruction = {
      payload: {
        parentMessageId: 'p1',
        toolCalling: {
          apiName: 'calculator',
          arguments: '{}',
          id: 'call_1',
          identifier: 'calculator',
          type: 'default',
        },
      },
      type: 'call_tool',
    };

    const execResult = await host.execute(instruction, state, context);
    expect(execResult.newState.status).toBe('running');
    expect(callToolExecutor).toHaveBeenCalledWith(instruction, state, context);

    await host.dispose();
  });

  it('[2] isolates multiple host instances without crosstalk', async () => {
    const finishInst1: AgentInstruction = {
      reason: 'completed',
      reasonDetail: 'done1',
      type: 'finish',
    };
    const finishInst2: AgentInstruction = {
      reason: 'completed',
      reasonDetail: 'done2',
      type: 'finish',
    };

    const runner1: Agent['runner'] = vi.fn().mockResolvedValue(finishInst1);
    const runner2: Agent['runner'] = vi.fn().mockResolvedValue(finishInst2);
    const executor1: InstructionExecutor = vi.fn().mockResolvedValue({
      events: [],
      newState: createMockState({ status: 'interrupted' }),
    });
    const executor2: InstructionExecutor = vi.fn().mockResolvedValue({
      events: [],
      newState: createMockState({ status: 'done' }),
    });

    const host1 = createHost({ runner: runner1 }, { finish: executor1 });
    const host2 = createHost({ runner: runner2 }, { finish: executor2 });

    await Promise.all([host1.ready(), host2.ready()]);

    expect(host1.native).not.toBe(host2.native);

    const state = createMockState();
    const context = createMockContext();
    const finishInstruction: AgentInstruction = { reason: 'completed', type: 'finish' };

    const plan1 = await host1.plan(context, state);
    expect(plan1).toEqual(finishInst1);
    expect(runner1).toHaveBeenCalledTimes(1);
    expect(runner2).not.toHaveBeenCalled();

    const exec2 = await host2.execute(finishInstruction, state, context);
    expect(exec2.newState.status).toBe('done');
    expect(executor2).toHaveBeenCalledTimes(1);
    expect(executor1).not.toHaveBeenCalled();

    await Promise.all([host1.dispose(), host2.dispose()]);
  });

  it('[3] rewrites request input via waterfall hook', async () => {
    const capturedPlanInputs: { context: AgentRuntimeContext; state: AgentState }[] = [];
    const agent: Agent = {
      runner: async (ctx, st): Promise<AgentInstruction> => {
        capturedPlanInputs.push({ context: ctx, state: st });
        return { reason: 'completed', type: 'finish' };
      },
    };

    const capturedExecInputs: { instruction: AgentInstruction }[] = [];
    const finishExecutor: InstructionExecutor = async (inst, st) => {
      capturedExecInputs.push({ instruction: inst });
      return { events: [], newState: st };
    };

    const host = createHost(agent, { finish: finishExecutor });
    await host.ready();

    // Register waterfall hooks modifying request object properties
    host.native.on('qingzhou.agent.plan', async (req, next) => {
      req.context = { ...req.context, phase: 'human_response' };
      req.state = { ...req.state, stepCount: 99 };
      return next();
    });

    host.native.on('qingzhou.agent.execute', async (req, next) => {
      req.instruction = { reason: 'completed', reasonDetail: 'rewritten', type: 'finish' };
      return next();
    });

    const context = createMockContext({ phase: 'init' });
    const state = createMockState({ stepCount: 1 });

    await host.plan(context, state);
    expect(capturedPlanInputs[0].context.phase).toBe('human_response');
    expect(capturedPlanInputs[0].state.stepCount).toBe(99);

    const originalInstruction: AgentInstruction = {
      reason: 'completed',
      reasonDetail: 'original',
      type: 'finish',
    };
    await host.execute(originalInstruction, state, context);
    expect(capturedExecInputs[0].instruction).toEqual({
      reason: 'completed',
      reasonDetail: 'rewritten',
      type: 'finish',
    });

    await host.dispose();
  });

  it('[4] removes registered hook when plugin is disposed', async () => {
    let hookCalls = 0;
    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }),
    };

    const host = createHost(agent);
    await host.ready();

    const pluginFiber = host.native.plugin((ctx) => {
      ctx.on('qingzhou.agent.plan', async (req, next) => {
        hookCalls += 1;
        return next();
      });
    });
    await pluginFiber;

    const state = createMockState();
    const context = createMockContext();

    await host.plan(context, state);
    expect(hookCalls).toBe(1);

    await pluginFiber.dispose();

    await host.plan(context, state);
    expect(hookCalls).toBe(1);

    await host.dispose();
  });

  it('[5] throws explicit error for missing executor', async () => {
    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }),
    };

    const host = createHost(agent, {});
    await host.ready();

    expect(host.hasExecutor('call_llm')).toBe(false);

    const instruction: AgentInstruction = {
      payload: { messages: [], model: 'gpt-4o', provider: 'openai', tools: [] },
      type: 'call_llm',
    };

    await expect(host.execute(instruction, createMockState())).rejects.toThrow(
      'No executor found for instruction type: call_llm',
    );

    await host.dispose();
  });

  it('[6] waits for in-flight and deferred tasks during dispose', async () => {
    const gate = deferred<void>();
    let taskCompleted = false;

    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => {
        await gate.promise;
        taskCompleted = true;
        return { reason: 'completed', reasonDetail: 'delayed', type: 'finish' };
      },
    };

    const host = createHost(agent);
    await host.ready();

    try {
      const planPromise = host.plan(createMockContext(), createMockState());
      let disposeFinished = false;

      const disposePromise = host.dispose().then(() => {
        disposeFinished = true;
      });

      // Microtasks flush: dispose must wait for gate to resolve
      await Promise.resolve();
      await Promise.resolve();
      expect(disposeFinished).toBe(false);
      expect(taskCompleted).toBe(false);

      gate.resolve();

      const result = await planPromise;
      expect(result).toEqual({ reason: 'completed', reasonDetail: 'delayed', type: 'finish' });
      expect(taskCompleted).toBe(true);

      await disposePromise;
      expect(disposeFinished).toBe(true);
    } finally {
      gate.resolve();
      await host.dispose();
    }
  });

  it('[7] rejects new calls after dispose and dispose is idempotent', async () => {
    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }),
    };
    const executor: InstructionExecutor = async (_inst, state) => ({ events: [], newState: state });

    const host = createHost(agent, { finish: executor });
    await host.ready();

    const p1 = host.dispose();
    const p2 = host.dispose();
    expect(p1).toBe(p2);
    await p1;

    expect(host.hasExecutor('finish')).toBe(false);

    await expect(host.ready()).rejects.toMatchObject({
      code: 'CORDIS_AGENT_HOST_DISPOSED',
    });

    await expect(host.plan(createMockContext(), createMockState())).rejects.toMatchObject({
      code: 'CORDIS_AGENT_HOST_DISPOSED',
    });

    await expect(
      host.execute({ reason: 'completed', type: 'finish' }, createMockState()),
    ).rejects.toMatchObject({
      code: 'CORDIS_AGENT_HOST_DISPOSED',
    });
  });

  it('[8] preserves this receiver on agent.runner', async () => {
    class CustomAgent implements Agent {
      readonly agentIdentifier = 'custom-brain-42';

      async runner(
        this: CustomAgent,
        _context: AgentRuntimeContext,
        _state: AgentState,
      ): Promise<AgentInstruction> {
        expect(this.agentIdentifier).toBe('custom-brain-42');
        return {
          reason: 'completed',
          reasonDetail: this.agentIdentifier,
          type: 'finish',
        };
      }
    }

    const agent = new CustomAgent();
    const host = createHost(agent);
    await host.ready();

    const result = await host.plan(createMockContext(), createMockState());
    expect(result).toEqual({
      reason: 'completed',
      reasonDetail: 'custom-brain-42',
      type: 'finish',
    });

    await host.dispose();
  });

  it('[9] cleans up and rolls back on startup failure', async () => {
    const startupError = new Error('simulated runner plugin startup failure');
    const failingAgent: Agent = {
      get runner(): never {
        throw startupError;
      },
    };

    const host = createHost(failingAgent);

    await expect(host.ready()).rejects.toBe(startupError);

    // Host disposal after failure settles cleanly without throwing unhandled rejection
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it('[10] handles dispose during ready/mount cleanly', async () => {
    const agent: Agent = {
      runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }),
    };

    const host = createHost(agent);
    // Dispose immediately before awaiting ready
    const disposePromise = host.dispose();
    await expect(disposePromise).resolves.toBeUndefined();

    // After dispose during mount, subsequent calls must be rejected
    await expect(host.plan(createMockContext(), createMockState())).rejects.toMatchObject({
      code: 'CORDIS_AGENT_HOST_DISPOSED',
    });
  });

  it('[11] propagates rejecting task error without unhandled rejection during dispose', async () => {
    const taskError = new Error('executor exploded');
    const failingExecutor: InstructionExecutor = vi.fn().mockRejectedValue(taskError);

    const host = createHost(
      { runner: async (): Promise<AgentInstruction> => ({ reason: 'completed', type: 'finish' }) },
      { finish: failingExecutor },
    );
    await host.ready();

    const executePromise = host.execute({ reason: 'completed', type: 'finish' }, createMockState());
    const disposePromise = host.dispose();

    await expect(executePromise).rejects.toBe(taskError);
    await expect(disposePromise).resolves.toBeUndefined();
  });

  it('[12] handles synchronous error when snapshotting executors before context allocation', () => {
    const snapshotError = new Error('executors snapshot failed');
    const badExecutors: Partial<Record<AgentInstruction['type'], InstructionExecutor>> = {
      get finish(): never {
        throw snapshotError;
      },
    };

    expect(
      () =>
        new CordisAgentHost(
          {
            runner: async (): Promise<AgentInstruction> => ({
              reason: 'completed',
              type: 'finish',
            }),
          },
          badExecutors,
        ),
    ).toThrow(snapshotError);
  });
});
