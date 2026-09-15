import type { RuntimePluginManifest } from '../../../../packages/cordis-kernel/src/types';
import { isDuplicateToolError, resolveToolRegistry } from './registry-helper';
import type { McpClientLike, McpPluginOptions } from './types';

export const disconnectMcpClient = async (client: McpClientLike): Promise<void> => {
  if (typeof client.disconnect === 'function') {
    await client.disconnect();
  } else if (typeof client.close === 'function') {
    await client.close();
  }
};

export const createMcpPluginManifest = (options: McpPluginOptions): RuntimePluginManifest => {
  const pluginId = `mcp.${options.id}`;
  const version = options.version ?? '1.0.0';

  return {
    apply: async (ctx) => {
      const toolRegistry = resolveToolRegistry(ctx, 'MCP plugin');

      let disconnected = false;
      const disconnectOnce = async (clientInstance: McpClientLike) => {
        if (disconnected) return;
        disconnected = true;
        await disconnectMcpClient(clientInstance);
      };

      // 1. Kick off client factory promise
      const clientPromise = Promise.resolve().then(async () => {
        if (options.clientFactory) {
          return await options.clientFactory(options.clientParams);
        }
        const { MCPClient } = await import('@/libs/mcp');
        const mcpClient = new MCPClient(options.clientParams);
        return mcpClient as unknown as McpClientLike;
      });

      // 2. Register cleanup ownership in ctx.effect BEFORE awaiting the promise
      ctx.effect(async () => {
        const client = await clientPromise;
        return () => disconnectOnce(client);
      });

      // 3. Await the client promise
      const client = await clientPromise;

      // 4. Verify fiber state: must be loading or active
      const fiberState = ctx.fiber.state;
      if (fiberState !== 'loading' && fiberState !== 'active') {
        throw new Error(`MCP plugin mount aborted: fiber is ${fiberState}`);
      }

      if (!options.clientFactory && typeof client.initialize === 'function') {
        await client.initialize();
      }

      // 5. Unconditionally provide client (staging will reject as expected)
      ctx.provide(`mcp.client.${options.id}`, client);

      // 6. Discover and register all tools from the MCP server
      const tools = await client.listTools();
      if ((!tools || tools.length === 0) && !options.allowEmptyTools) {
        throw new Error(
          `MCP server "${options.id}" returned no tools and allowEmptyTools is not enabled`,
        );
      }

      for (const tool of tools) {
        const canonicalName = `${options.id}:${tool.name}`;

        toolRegistry.register(ctx, {
          description: tool.description ?? `MCP tool ${canonicalName}`,
          execute: async (args) => {
            return await client.callTool(tool.name, args);
          },
          inputSchema: tool.inputSchema ?? {},
          name: canonicalName,
        });

        // Register short alias if not already taken
        try {
          toolRegistry.register(ctx, {
            description: tool.description ?? `MCP tool ${tool.name}`,
            execute: async (args) => {
              return await client.callTool(tool.name, args);
            },
            inputSchema: tool.inputSchema ?? {},
            name: tool.name,
          });
        } catch (error) {
          if (!isDuplicateToolError(error)) {
            throw error;
          }
          // If collision occurs, canonicalName remains available
        }
      }
    },
    id: pluginId,
    inject: ['cordis.tools'],
    kind: 'capability',
    version,
  };
};
