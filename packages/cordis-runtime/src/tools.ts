import { type Context } from '@lobechat/cordis-foundation';

import { CordisProfileLoader, type ProfileDefinition } from './loader';

export interface ToolMetadata {
  description?: string;
  inputSchema?: unknown;
  name: string;
}

export interface NativeTool<T = unknown> extends ToolMetadata {
  /** Trusted execution context belongs in this closure, never in model arguments. */
  execute: (input: unknown) => Promise<T>;
}

export interface NativeToolRequest {
  input: unknown;
  name: string;
}

interface ToolServices {
  [name: `qingzhou.tool.${string}`]: NativeTool;
}

declare module '@lobechat/cordis-foundation' {
  interface Context extends ToolServices {
    'qingzhou.tools.catalog': { list: () => ToolMetadata[] };
  }
  interface Events {
    'qingzhou.tools.execute': (
      request: NativeToolRequest,
      next: () => Promise<unknown>,
    ) => Promise<unknown>;
  }
}

export const canonicalToolName = (identifier: string, apiName: string): string => {
  if (!identifier || !apiName || identifier.includes(':') || apiName.includes(':')) {
    throw new Error('CORDIS_TOOL_INVALID_NAME');
  }
  return `${identifier}:${apiName}`;
};

/** A catalog is a projection of active native tool services, not a second handler table. */
export class CordisToolRuntime<T = unknown> {
  private readonly loader: CordisProfileLoader;

  constructor(tools: readonly NativeTool<T>[]) {
    this.loader = new CordisProfileLoader(this.definition(tools));
  }

  private definition(tools: readonly NativeTool<T>[]): ProfileDefinition {
    const names = new Set<string>();
    const snapshots = tools.map(({ execute, ...metadata }) => {
      if (!metadata.name.trim() || names.has(metadata.name))
        throw new Error('CORDIS_TOOL_DUPLICATE_OR_INVALID');
      names.add(metadata.name);
      return { ...structuredClone(metadata), execute };
    });
    const modules: ProfileDefinition['modules'] = Object.fromEntries(
      snapshots.map((tool) => [
        `tool:${tool.name}`,
        {
          plugin: {
            apply(ctx: Context) {
              ctx.provide(`qingzhou.tool.${tool.name}`, tool);
            },
          },
        },
      ]),
    );
    return {
      bundles: {
        tools: {
          entries: [
            ...snapshots.map(({ name }) => ({ id: `tool:${name}`, use: `tool:${name}` })),
            { id: '$catalog', use: '$catalog' },
          ],
        },
      },
      modules: {
        ...modules,
        $catalog: {
          plugin: {
            apply(ctx) {
              ctx.provide('qingzhou.tools.catalog', {
                list: () =>
                  snapshots.flatMap(({ name }) => {
                    const tool = ctx.get(`qingzhou.tool.${name}`);
                    if (!tool) return [];
                    const { execute: _, ...metadata } = tool;
                    return [structuredClone(metadata)];
                  }),
              });
            },
          },
        },
      },
      profile: { bundles: ['tools'] },
    };
  }

  list(): Promise<ToolMetadata[]> {
    return this.loader.run(async (ctx) => {
      const catalog = ctx.get('qingzhou.tools.catalog');
      if (!catalog) throw new Error('CORDIS_TOOL_CATALOG_UNAVAILABLE');
      return catalog.list();
    });
  }

  execute(name: string, input: unknown): Promise<T> {
    return this.loader.run(async (ctx) => {
      const request = { input, name };
      const result = await ctx.waterfall('qingzhou.tools.execute', request, async () => {
        const tool = ctx.get(`qingzhou.tool.${request.name}`);
        if (!tool) throw new Error(`CORDIS_TOOL_NOT_FOUND: ${request.name}`);
        return tool.execute(request.input);
      });
      // Every provider in this private generation is registered with result type T.
      // Cordis module augmentation cannot express a per-instance generic service map.
      return result as T;
    });
  }

  reload(tools: readonly NativeTool<T>[]): Promise<void> {
    return this.loader.reload(this.definition(tools));
  }

  /** Trusted plugin installation/inspection; not exposed as an agent tool. */
  withContext<R>(action: (context: Context) => Promise<R>): Promise<R> {
    return this.loader.run(action);
  }

  dispose(): Promise<void> {
    return this.loader.dispose();
  }
}

/** Request-owned adapter for existing browser/server entry points. */
export async function invokeNativeTool<T>(tool: NativeTool<T>, input: unknown): Promise<T> {
  const runtime = new CordisToolRuntime([tool]);
  try {
    return await runtime.execute(tool.name, input);
  } finally {
    await runtime.dispose();
  }
}
