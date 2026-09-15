import type { ChatToolPayload } from '@lobechat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentRuntimeContext } from '../../types';
import { AgentRuntime } from '../runtime';

const runtimes: AgentRuntime[] = [];
const createRuntime = (agent: Agent) => {
  const runtime = new AgentRuntime(agent);
  runtimes.push(runtime);
  return runtime;
};
const context: AgentRuntimeContext = {
  phase: 'user_input',
  payload: {},
  session: { messageCount: 0, sessionId: 'native-chat', status: 'running', stepCount: 0 },
};
const tool: ChatToolPayload = {
  apiName: 'probe',
  arguments: '{}',
  id: 'tool-1',
  identifier: 'probe',
  type: 'default',
};
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('AgentRuntime default Cordis execution', () => {
  it('dispatches a batch and every child tool through native hooks', async () => {
    const probe = vi.fn(async () => ({ result: 'real executor' }));
    const runtime = createRuntime({
      runner: async () => ({
        type: 'call_tools_batch',
        payload: { parentMessageId: 'parent', toolsCalling: [tool, { ...tool, id: 'tool-2' }] },
      }),
      tools: { probe },
    });
    const dispatched: string[] = [];
    const hook = runtime.cordis.native.plugin({
      name: 'test-dispatch-observer',
      apply(ctx) {
        ctx.on('qingzhou.agent.execute', (request, next) => {
          dispatched.push(request.instruction.type);
          return next();
        });
      },
    });
    await hook.await();
    const state = AgentRuntime.createInitialState({ operationId: 'native-chat' });
    const result = await runtime.step(state, context);
    expect(dispatched).toEqual(['call_tools_batch', 'call_tool', 'call_tool']);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.events.filter((event) => event.type === 'tool_result')).toHaveLength(2);
    expect(result.newState.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
    expect(result.nextContext?.phase).toBe('tools_batch_result');
  });

  it('keeps approved-tool execution on the native path without replanning it', async () => {
    const runner = vi.fn<Agent['runner']>();
    const runtime = createRuntime({ runner, tools: { probe: vi.fn(async () => 'approved') } });
    const seen = vi.fn();
    const hook = runtime.cordis.native.plugin({
      name: 'test-approval-observer',
      apply(ctx) {
        ctx.on('qingzhou.agent.execute', (request, next) => {
          seen(request.instruction.type);
          return next();
        });
      },
    });
    await hook.await();
    const result = await runtime.step(
      AgentRuntime.createInitialState({ operationId: 'native-chat' }),
      {
        ...context,
        phase: 'human_approved_tool',
        payload: { approvedToolCall: tool, parentMessageId: 'parent', skipCreateToolMessage: true },
      },
    );
    expect(runner).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledWith('call_tool');
    expect(result.events[0]?.type).toBe('tool_result');
  });

  it('honors a native plugin veto before a tool produces a side effect', async () => {
    const probe = vi.fn(async () => 'should not run');
    const runtime = createRuntime({
      runner: async () => ({
        type: 'call_tool',
        payload: { parentMessageId: 'parent', toolCalling: tool },
      }),
      tools: { probe },
    });
    const guard = runtime.cordis.native.plugin({
      name: 'test-execution-guard',
      apply(ctx) {
        ctx.on('qingzhou.agent.execute', () => {
          throw new Error('policy rejected');
        });
      },
    });
    await guard.await();
    const result = await runtime.step(
      AgentRuntime.createInitialState({ operationId: 'native-chat' }),
      context,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(result.newState.status).toBe('error');
    expect(result.events[0]).toMatchObject({ type: 'error' });
  });
  it('rejects an execution hook that changes instruction kind and bypasses step accounting', async () => {
    const probe = vi.fn(async () => 'must not run');
    const runtime = createRuntime({
      runner: async () => ({ type: 'finish', reason: 'completed' }),
      tools: { probe },
    });
    const plugin = runtime.cordis.native.plugin({
      name: 'test-invalid-instruction-rewrite',
      apply(ctx) {
        ctx.on('qingzhou.agent.execute', (request, next) => {
          request.instruction = {
            type: 'call_tool',
            payload: { parentMessageId: 'parent', toolCalling: tool },
          };
          return next();
        });
      },
    });
    await plugin.await();
    const result = await runtime.step(
      AgentRuntime.createInitialState({ operationId: 'native-chat' }),
      context,
    );
    expect(result.newState.status).toBe('error');
    expect(probe).not.toHaveBeenCalled();
  });
});
