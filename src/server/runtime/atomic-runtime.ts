import { randomUUID } from 'node:crypto';

import { type PluginBundle, type PluginProfile, resolveProfile } from '@lobechat/cordis-runtime';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { RuntimeContext } from '../../../packages/cordis-kernel/src';
import type { RuntimeScope } from '../../../packages/runtime-contracts/src';
import { CordisAtomicHost, type CordisAtomicInstance } from './cordis-atomic-host';

export interface AtomicInvocation {
  readonly jobId?: string;
  readonly onEvent?: (event: AtomicOperationEvent) => void;
  readonly scope: RuntimeScope;
  readonly services?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}
export interface AtomicOperationEvent {
  /** Trusted, prompt-free subject supplied by the executing capability. */
  detail?: string;
  errorCode?: string;
  jobId?: string;
  name: string;
  operationId: string;
  pluginVersion: string;
  state: 'started' | 'completed' | 'failed';
  timestamp: string;
}
export interface AtomicAgentMetadata {
  /** Trusted discovery contexts; `skills` opts an operation into composition. */
  readonly contexts: readonly string[];
  /** Maximum attempts for this operation in one autonomous composition. */
  readonly maxCalls?: number;
}
export interface AtomicOperation {
  /** Trusted plugin opt-in to agent discovery; never accepted from user input. */
  agent?: AtomicAgentMetadata;
  description: string;
  execute: (input: any, invocation: AtomicInvocation) => unknown | Promise<unknown>;
  input: ZodTypeAny;
  name: string;
  output?: ZodTypeAny;
}
export interface AtomicPlugin {
  id: string;
  operations: AtomicOperation[];
  version: string;
}
export interface AtomicRuntimeOptions {
  /** Maximum scopes retained for diagnostics; zero disables retained history. */
  maxEventScopes?: number;
  /** Maximum recent operation events per scope. Live event callbacks are unaffected. */
  maxEventsPerScope?: number;
}
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
/** Preserve the invocation cancellation contract across tools and model decisions. */
export const assertAtomicInvocationActive = (invocation: AtomicInvocation): void => {
  if (invocation.signal?.aborted)
    throw fail('PRESENTATION_WORKER_CANCELLED', 'Operation cancelled');
};
const scopeSchema = z.object({
  userId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
});

/** Generic plugin host. Trusted invocation context is never accepted in tool arguments. */
export class AtomicRuntime {
  private readonly host = new CordisAtomicHost();
  private readonly registry = this.host.tools;
  private readonly instances = new Map<string, CordisAtomicInstance>();
  private readonly plugins = new Map<string, AtomicPlugin>();
  private readonly leases = new Map<string, number>();
  private readonly changing = new Set<string>();
  private readonly events = new Map<string, AtomicOperationEvent[]>();
  private readonly controllers = new Set<AbortController>();
  private readonly maxEventScopes: number;
  private readonly maxEventsPerScope: number;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(plugins: AtomicPlugin[] = [], options: AtomicRuntimeOptions = {}) {
    const limits = z
      .object({
        maxEventScopes: z.number().int().nonnegative().safe().default(256),
        maxEventsPerScope: z.number().int().nonnegative().safe().default(200),
      })
      .parse(options);
    this.maxEventScopes = limits.maxEventScopes;
    this.maxEventsPerScope = limits.maxEventsPerScope;
    for (const plugin of plugins) this.pending = this.pending.then(() => this.install(plugin));
  }

  private manifest(plugin: AtomicPlugin) {
    const names = new Set<string>();
    for (const operation of plugin.operations) {
      if (!operation.name.startsWith(`${plugin.id}.`) || names.has(operation.name))
        throw fail(
          'PLUGIN_INVALID',
          'Operations must have unique names inside their plugin namespace',
        );
      if (
        operation.agent?.maxCalls !== undefined &&
        (!Number.isSafeInteger(operation.agent.maxCalls) || operation.agent.maxCalls < 1)
      )
        throw fail('PLUGIN_INVALID', 'Agent operation budgets must be positive integers');
      names.add(operation.name);
    }
    return {
      id: plugin.id,
      version: plugin.version,
      kind: 'capability' as const,
      permissions: { tools: [...names] },
      apply: (ctx: RuntimeContext) => {
        for (const operation of plugin.operations)
          this.registry.register(ctx, {
            name: operation.name,
            description: operation.description,
            inputSchema: zodToJsonSchema(operation.input, { $refStrategy: 'none' }),
            execute: async (raw, executionContext) => {
              const invocation = (executionContext as unknown as { invocation: AtomicInvocation })
                .invocation;
              const parsed = operation.input.safeParse(raw);
              if (!parsed.success)
                throw fail(
                  'PRESENTATION_INVALID',
                  parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
                );
              assertAtomicInvocationActive(invocation);
              const value = await operation.execute(parsed.data, invocation);
              assertAtomicInvocationActive(invocation);
              return operation.output ? operation.output.parse(value) : value;
            },
          });
      },
    };
  }

  private async install(plugin: AtomicPlugin) {
    let instance: CordisAtomicInstance;
    try {
      instance = await this.host.mount(this.manifest(plugin));
    } catch (cause) {
      throw Object.assign(fail('PLUGIN_START_FAILED', `Cannot mount ${plugin.id}`), { cause });
    }
    if (this.disposed) {
      await instance.dispose();
      throw fail('PROVIDER_UNAVAILABLE', 'Runtime is disposed');
    }
    this.instances.set(plugin.id, instance);
    this.plugins.set(plugin.id, plugin);
  }

  async add(plugin: AtomicPlugin) {
    await this.pending;
    if (this.disposed || this.plugins.has(plugin.id) || this.changing.has(plugin.id))
      throw fail('PLUGIN_BUSY', 'Plugin is already installed or changing');
    this.changing.add(plugin.id);
    try {
      await this.install(plugin);
    } finally {
      this.changing.delete(plugin.id);
    }
  }
  async remove(pluginId: string) {
    await this.pending;
    if (this.changing.has(pluginId) || (this.leases.get(pluginId) ?? 0) > 0)
      throw fail('PLUGIN_BUSY', 'Finish or cancel active jobs before unloading this plugin');
    this.changing.add(pluginId);
    try {
      await this.instances.get(pluginId)?.dispose();
      this.instances.delete(pluginId);
      this.plugins.delete(pluginId);
    } finally {
      this.changing.delete(pluginId);
    }
  }

  async withPlugins<T>(pluginIds: string[], operation: () => Promise<T>): Promise<T> {
    const release: (() => void)[] = [];
    try {
      for (const id of [...new Set(pluginIds)].sort()) release.push(await this.acquire(id));
      return await operation();
    } finally {
      for (const done of release.reverse()) done();
    }
  }

  async acquire(pluginId: string): Promise<() => void> {
    await this.pending;
    if (this.disposed || this.changing.has(pluginId) || !this.plugins.has(pluginId))
      throw fail('PROVIDER_UNAVAILABLE', `Plugin ${pluginId} is unavailable`);
    this.leases.set(pluginId, (this.leases.get(pluginId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(pluginId, (this.leases.get(pluginId) ?? 1) - 1);
    };
  }

  async invoke<T = unknown>(
    name: string,
    input: unknown,
    invocation: AtomicInvocation,
  ): Promise<T> {
    scopeSchema.parse(invocation.scope);
    const pluginId = name.split('.')[0];
    const release = await this.acquire(pluginId);
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = invocation.signal
      ? AbortSignal.any([invocation.signal, controller.signal])
      : controller.signal;
    const scopeKey = JSON.stringify([invocation.scope.userId, invocation.scope.sessionId]);
    const event = {
      name,
      jobId: invocation.jobId,
      operationId: randomUUID(),
      pluginVersion: this.plugins.get(pluginId)!.version,
    };
    const publish = (state: AtomicOperationEvent['state'], errorCode?: string) => {
      const item = { ...event, state, errorCode, timestamp: new Date().toISOString() };
      if (this.maxEventScopes > 0 && this.maxEventsPerScope > 0) {
        const history = this.events.get(scopeKey) ?? [];
        history.push(item);
        if (history.length > this.maxEventsPerScope)
          history.splice(0, history.length - this.maxEventsPerScope);
        // Keep the scopes with the most recent events; eviction only affects diagnostics.
        this.events.delete(scopeKey);
        this.events.set(scopeKey, history);
        if (this.events.size > this.maxEventScopes) {
          const oldest = this.events.keys().next().value;
          if (oldest !== undefined) this.events.delete(oldest);
        }
      }
      invocation.onEvent?.(item);
    };
    try {
      publish('started');
      const ctx = Object.assign(this.host.context.withScope(scopeKey), {
        invocation: { ...invocation, signal },
      });
      const result = await this.registry.execute(name, input, ctx);
      publish('completed');
      return result as T;
    } catch (error) {
      publish('failed', (error as { code?: string })?.code ?? 'OPERATION_FAILED');
      throw error;
    } finally {
      this.controllers.delete(controller);
      release();
    }
  }

  async catalog() {
    await this.pending;
    return this.registry.list().map((tool) => {
      const plugin = this.plugins.get(tool.name.split('.')[0]);
      const agent = plugin?.operations.find((operation) => operation.name === tool.name)?.agent;
      return {
        ...tool,
        agent: agent ? { ...agent, contexts: [...agent.contexts] } : undefined,
        pluginVersion: plugin?.version,
      };
    });
  }
  async snapshot(scope: RuntimeScope) {
    scopeSchema.parse(scope);
    await this.pending;
    return {
      plugins: [...this.instances.values()].map((instance) => ({
        id: instance.id,
        version: instance.version,
        kind: 'capability' as const,
        permissions: { tools: this.plugins.get(instance.id)!.operations.map((op) => op.name) },
        state: instance.state,
        error: instance.error,
      })),
      operations: [...(this.events.get(JSON.stringify([scope.userId, scope.sessionId])) ?? [])],
    };
  }

  /** A whole job holds a lease: replacement never mixes implementation versions mid-job. */
  async replace(plugin: AtomicPlugin) {
    await this.pending;
    if (this.disposed || this.changing.has(plugin.id) || (this.leases.get(plugin.id) ?? 0) > 0)
      throw fail('PLUGIN_BUSY', 'Finish or cancel active jobs before replacing this plugin');
    this.changing.add(plugin.id);
    try {
      let candidate: CordisAtomicInstance | undefined;
      try {
        candidate = await this.host.mount(this.manifest(plugin), true);
        if (this.disposed) throw fail('PROVIDER_UNAVAILABLE', 'Runtime is disposed');
        this.host.commit(candidate);
      } catch (cause) {
        if (candidate) {
          this.host.discard(candidate);
          await candidate.dispose();
        }
        throw Object.assign(fail('PLUGIN_START_FAILED', `Cannot replace ${plugin.id}`), { cause });
      }
      const previous = this.instances.get(plugin.id);
      this.instances.set(plugin.id, candidate);
      this.plugins.set(plugin.id, plugin);
      await previous?.dispose();
    } finally {
      this.changing.delete(plugin.id);
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.disposal = (async () => {
      await this.pending.catch(() => undefined);
      await this.host.dispose();
      this.instances.clear();
      this.plugins.clear();
      this.events.clear();
    })();
    return this.disposal;
  }
}

/** Resolve a trusted application profile before allocating any plugin resources. */
export function createAtomicRuntimeFromProfile(definition: {
  bundles: Readonly<Record<string, PluginBundle>>;
  modules: Readonly<Record<string, AtomicPlugin>>;
  profile: PluginProfile;
}): AtomicRuntime {
  const plugins = resolveProfile(definition.profile, definition.bundles).map((entry) => {
    const plugin = Object.hasOwn(definition.modules, entry.use)
      ? definition.modules[entry.use]
      : undefined;
    if (!plugin) throw fail('PLUGIN_NOT_FOUND', `Unknown atomic module ${entry.use}`);
    if (entry.id !== plugin.id || Object.keys(entry.config ?? {}).length) {
      throw fail(
        'PLUGIN_INVALID',
        'Atomic profiles preserve plugin IDs; configure modules in their trusted factories',
      );
    }
    return plugin;
  });
  return new AtomicRuntime(plugins);
}
