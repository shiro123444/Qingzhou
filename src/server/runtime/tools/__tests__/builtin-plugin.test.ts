import { describe, expect, it, vi } from 'vitest';

import { Context } from '../../../../../packages/cordis-kernel/src/context';
import { PluginManager } from '../../../../../packages/cordis-kernel/src/manager';
import { ToolRegistry } from '../../../../../packages/cordis-kernel/src/tool';
import { createBuiltinToolsPlugin } from '../builtin-plugin';

describe('createBuiltinToolsPlugin', () => {
  it('registers tools into Cordis ToolRegistry and unregisters on disposal', async () => {
    const context = new Context();
    const toolRegistry = new ToolRegistry();
    context.provide('cordis.tools', toolRegistry);

    const mockHandler = vi.fn(async (args: unknown) => ({
      content: `Doc created: ${(args as { title: string }).title}`,
      success: true,
    }));

    const plugin = createBuiltinToolsPlugin({
      id: 'tools.builtin',
      tools: [
        {
          apiName: 'createDocument',
          description: 'Creates a new document',
          handler: mockHandler,
          identifier: 'lobe-notebook',
        },
      ],
    });

    const manager = new PluginManager([plugin], context);
    await manager.mount('tools.builtin');

    // Both canonical and short name should be registered
    const tools = toolRegistry.list();
    expect(tools.map((t) => t.name)).toContain('lobe-notebook:createDocument');
    expect(tools.map((t) => t.name)).toContain('createDocument');

    // Execute through ToolRegistry with valid service context contract
    Object.assign(context, { toolManifestMap: {} });
    const result = (await toolRegistry.execute(
      'lobe-notebook:createDocument',
      { title: 'My Note' },
      context as any,
    )) as { content: string };
    expect(result.content).toBe('Doc created: My Note');
    expect(mockHandler).toHaveBeenCalledWith({ title: 'My Note' }, context);

    // Unmount plugin - fiber should clean up registered tools
    await manager.unmount('tools.builtin');
    const remainingTools = toolRegistry.list();
    expect(remainingTools.map((t) => t.name)).not.toContain('lobe-notebook:createDocument');
    expect(remainingTools.map((t) => t.name)).not.toContain('createDocument');
  });
});
