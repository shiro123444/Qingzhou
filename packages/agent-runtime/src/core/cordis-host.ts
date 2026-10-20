import { type Context } from '@lobechat/cordis-foundation';
import {
  LoadedProfile,
  type PluginBundle,
  type PluginProfile,
  type ProfileModule,
} from '@lobechat/cordis-runtime';

import type {
  Agent,
  AgentInstruction,
  AgentRuntimeContext,
  AgentState,
  InstructionExecutor,
} from '../types';

export interface AgentPlanRequest {
  context: AgentRuntimeContext;
  state: AgentState;
}

export interface AgentExecuteRequest {
  context?: AgentRuntimeContext;
  instruction: AgentInstruction;
  state: AgentState;
}

export type AgentExecutorServices = {
  [K in AgentInstruction['type'] as `qingzhou.agent.executor.${K}`]: InstructionExecutor;
};

declare module '@lobechat/cordis-foundation' {
  interface Context extends AgentExecutorServices {
    'qingzhou.agent.runner': Agent['runner'];
  }
  interface Events {
    'qingzhou.agent.execute': (
      request: AgentExecuteRequest,
      next: () => ReturnType<InstructionExecutor>,
    ) => ReturnType<InstructionExecutor>;
    'qingzhou.agent.plan': (
      request: AgentPlanRequest,
      next: () => ReturnType<Agent['runner']>,
    ) => ReturnType<Agent['runner']>;
  }
}

export interface AgentPluginComposition {
  bundles?: Record<string, PluginBundle>;
  modules?: Record<string, ProfileModule>;
  profile?: PluginProfile;
}

export class CordisAgentHost {
  readonly native: Context;
  private readonly agent: Agent;
  private readonly profile: LoadedProfile;
  private readonly initPromise: Promise<void>;
  private closed = false;
  private disposal?: Promise<void>;
  private readonly inFlightTasks = new Set<Promise<unknown>>();

  constructor(
    agent: Agent,
    executors: Partial<Record<AgentInstruction['type'], InstructionExecutor>> = {},
    composition: AgentPluginComposition = {},
  ) {
    // Snapshot executors entries before Context creation so synchronous getter errors don't leak resources
    const executorEntries = Object.entries(executors ?? {});

    this.agent = agent;
    const modules: Record<string, ProfileModule> = {
      runner: {
        plugin: {
          apply(ctx) {
            if (agent && typeof agent.runner === 'function') {
              ctx.provide('qingzhou.agent.runner', agent.runner);
            }
          },
          name: 'qingzhou.agent.runner',
        },
      },
    };
    for (const [type, executor] of executorEntries) {
      if (typeof executor !== 'function') continue;
      modules[`executor.${type}`] = {
        plugin: {
          apply(ctx) {
            ctx.provide(`qingzhou.agent.executor.${type}`, executor);
          },
          name: `qingzhou.agent.executor.${type}`,
        },
      };
    }
    const entries = Object.keys(modules).map((id) => ({ id, use: id }));
    for (const [id, module] of Object.entries(composition.modules ?? {})) {
      if (Object.hasOwn(modules, id)) throw new Error(`CORDIS_PROFILE_DUPLICATE_MODULE: ${id}`);
      modules[id] = module;
    }
    if (Object.hasOwn(composition.bundles ?? {}, 'agent')) {
      throw new Error('CORDIS_PROFILE_DUPLICATE_BUNDLE: agent');
    }
    this.profile = new LoadedProfile({
      bundles: { agent: { entries }, ...composition.bundles },
      modules,
      profile: composition.profile ?? { bundles: ['agent'] },
    });
    this.native = this.profile.native;
    this.initPromise = this.profile.ready;
  }

  private assertOpen(): void {
    if (this.closed) {
      const error = new Error('CordisAgentHost is disposed') as Error & { code: string };
      error.code = 'CORDIS_AGENT_HOST_DISPOSED';
      throw error;
    }
  }

  private async trackInFlight<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const promise = action();
    this.inFlightTasks.add(promise);
    try {
      return await promise;
    } finally {
      this.inFlightTasks.delete(promise);
    }
  }

  async ready(): Promise<void> {
    this.assertOpen();
    return this.initPromise;
  }

  hasExecutor(type: AgentInstruction['type']): boolean {
    if (this.closed) return false;
    return typeof this.native.get(`qingzhou.agent.executor.${type}`) === 'function';
  }

  async plan(context: AgentRuntimeContext, state: AgentState): ReturnType<Agent['runner']> {
    this.assertOpen();
    const request: AgentPlanRequest = { context, state };
    return this.trackInFlight(async () => {
      await this.ready();
      return this.native.waterfall('qingzhou.agent.plan', request, async () => {
        const runner = this.native.get('qingzhou.agent.runner');
        if (!runner || typeof runner !== 'function') {
          throw new Error('No agent runner registered in Cordis host');
        }
        return runner.call(this.agent, request.context, request.state);
      });
    });
  }

  async execute(
    instruction: AgentInstruction,
    state: AgentState,
    context?: AgentRuntimeContext,
  ): ReturnType<InstructionExecutor> {
    this.assertOpen();
    const instructionType = instruction.type;
    const request: AgentExecuteRequest = { context, instruction, state };
    return this.trackInFlight(async () => {
      await this.ready();
      return this.native.waterfall('qingzhou.agent.execute', request, async () => {
        // Instruction kind is part of AgentRuntime's finish/step accounting.
        // Change the plan in the plan hook; execution hooks may rewrite its arguments.
        if (request.instruction.type !== instructionType) {
          throw new Error(
            'Execution hooks cannot change instruction type; change the agent plan instead',
          );
        }
        const executor = this.native.get(`qingzhou.agent.executor.${request.instruction.type}`);
        if (!executor || typeof executor !== 'function') {
          throw new Error(`No executor found for instruction type: ${request.instruction.type}`);
        }
        return executor(request.instruction, request.state, request.context);
      });
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = (async () => {
      await this.initPromise.catch(() => {});
      while (this.inFlightTasks.size > 0) {
        await Promise.allSettled(Array.from(this.inFlightTasks));
      }
      await this.profile.dispose();
    })();
    return this.disposal;
  }
}
