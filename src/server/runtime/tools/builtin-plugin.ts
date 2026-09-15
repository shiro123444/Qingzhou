import type { ToolExecutionContext as ServiceToolExecutionContext } from '@/server/services/toolExecution/types';

import type { ToolExecutionContext as KernelToolExecutionContext } from '../../../../packages/cordis-kernel/src/tool';
import type { RuntimePluginManifest } from '../../../../packages/cordis-kernel/src/types';
import { isDuplicateToolError, resolveToolRegistry } from './registry-helper';
import type { BuiltinToolsPluginOptions } from './types';

const assertServiceContext = (toolCtx: unknown): ServiceToolExecutionContext => {
  if (
    typeof toolCtx !== 'object' ||
    toolCtx === null ||
    Array.isArray(toolCtx) ||
    !('toolManifestMap' in toolCtx) ||
    typeof toolCtx.toolManifestMap !== 'object' ||
    toolCtx.toolManifestMap === null ||
    Array.isArray(toolCtx.toolManifestMap)
  ) {
    throw new Error('Execution context must contain a valid toolManifestMap');
  }
  // Cordis also accepts symbols, but the existing business execution contract
  // uses string conversation ids. Never silently stringify an isolation label.
  if ('scope' in toolCtx && toolCtx.scope != null && typeof toolCtx.scope !== 'string') {
    throw new Error('Builtin tools require a string conversation scope');
  }
  return toolCtx as ServiceToolExecutionContext;
};

export const createBuiltinToolsPlugin = (
  options: BuiltinToolsPluginOptions,
): RuntimePluginManifest => {
  const pluginId = options.id ?? 'tools.builtin';
  const version = options.version ?? '1.0.0';

  return {
    apply: (ctx) => {
      const toolRegistry = resolveToolRegistry(ctx, 'builtin tools plugin');

      for (const tool of options.tools) {
        const canonicalName = `${tool.identifier}:${tool.apiName}`;

        toolRegistry.register(ctx, {
          description: tool.description ?? `Builtin tool ${canonicalName}`,
          execute: (args: unknown, toolCtx: KernelToolExecutionContext) =>
            tool.handler(args, assertServiceContext(toolCtx)),
          inputSchema: tool.inputSchema ?? {},
          name: canonicalName,
        });

        // Also register short name alias if not colliding
        try {
          toolRegistry.register(ctx, {
            description: tool.description ?? `Builtin tool ${tool.apiName}`,
            execute: (args: unknown, toolCtx: KernelToolExecutionContext) =>
              tool.handler(args, assertServiceContext(toolCtx)),
            inputSchema: tool.inputSchema ?? {},
            name: tool.apiName,
          });
        } catch (error) {
          if (!isDuplicateToolError(error)) {
            throw error;
          }
          // If alias already exists (collision between providers), canonicalName remains unique
        }
      }
    },
    id: pluginId,
    inject: ['cordis.tools'],
    kind: 'capability',
    version,
  };
};
