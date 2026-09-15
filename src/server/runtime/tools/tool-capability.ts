import type {
  CapabilityContext,
  CapabilityPort,
} from '../../../../packages/cordis-kernel/src/capability';
import type {
  ToolExecutionContext,
  ToolRegistry,
} from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimeContext } from '../../../../packages/cordis-kernel/src/types';
import { scopeOfContext } from './registry-helper';

export interface ToolCapabilityOptions {
  description?: string;
  id?: string;
  runtimeContext?: RuntimeContext;
}

const RESERVED_RUNTIME_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'scope', 'policy']);

const filterReservedRuntimeFields = (
  ctx: CapabilityContext,
  runtime: RuntimeContext,
): Record<string, unknown> => {
  const safeRecord: Record<string, unknown> = {};
  if (typeof ctx === 'object' && ctx !== null) {
    for (const key of Object.keys(ctx)) {
      // Includes private adapter fields such as native/host, as well as any
      // future lifecycle methods; enumerating today's public API is not enough.
      if (!RESERVED_RUNTIME_KEYS.has(key) && !(key in runtime)) {
        safeRecord[key] = ctx[key];
      }
    }
  }
  return safeRecord;
};

export const createToolCapabilityPort = (
  toolRegistry: ToolRegistry,
  options: ToolCapabilityOptions = {},
): CapabilityPort => {
  const id = options.id ?? 'tools.execution';
  return {
    descriptor: {
      capabilities: ['execute', 'list'],
      description: options.description ?? 'Cordis Native Tool Execution Capability',
      id,
      source: 'builtin',
    },
    execute: async (command: unknown, context: CapabilityContext): Promise<unknown> => {
      if (typeof command !== 'object' || command === null || Array.isArray(command)) {
        throw new Error('Tool capability command must be an object');
      }
      const record = command as Record<string, unknown>;
      const action = record.action ?? 'execute';

      // Authorization comes strictly from context, NEVER command.scope
      const trustedScope = scopeOfContext(context) ?? scopeOfContext(options.runtimeContext);

      if (action === 'list') {
        const allTools = toolRegistry.list();
        return allTools.filter(
          (t) => t.scope === undefined || (trustedScope !== undefined && t.scope === trustedScope),
        );
      }

      if (action === 'execute') {
        const name = record.name;
        if (typeof name !== 'string' || !name.trim()) {
          throw new Error('Tool execution requires a non-empty tool name');
        }

        if (!options.runtimeContext) {
          throw new Error('Tool capability execution requires a runtimeContext');
        }
        const runtime: ToolExecutionContext = options.runtimeContext;

        const allTools = toolRegistry.list();
        const registeredTool = allTools.find((t) => t.name === name);
        if (!registeredTool) {
          throw new Error(`Tool "${name}" is not registered`);
        }

        if (
          registeredTool.scope !== undefined &&
          (trustedScope === undefined || registeredTool.scope !== trustedScope)
        ) {
          throw new Error(`Tool "${name}" is not accessible in the current scope`);
        }

        const args = record.args ?? record.arguments;

        // Derive fresh invocation context using runtimeContext
        const baseContext: RuntimeContext =
          trustedScope !== undefined ? runtime.withScope(trustedScope) : Object.create(runtime);

        // Filter out reserved runtime properties to prevent overwriting runtime functions and fiber
        const safeFields = filterReservedRuntimeFields(context, baseContext);
        const invocationContext = Object.assign(baseContext, safeFields, {
          policy: runtime.policy,
          scope: trustedScope,
        });
        return await toolRegistry.execute(name, args, invocationContext);
      }

      throw new Error(`Unsupported tool capability action: ${String(action)}`);
    },
    id,
  };
};
