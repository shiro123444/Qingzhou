import { Context } from '@lobechat/cordis-foundation';
import { describe, expect, it, vi } from 'vitest';

import { canonicalToolName, CordisToolRuntime, invokeNativeTool } from './tools';

describe('native tool catalog', () => {
  it('discovers active services, rewrites arguments via a native hook, and removes plugin hooks', async () => {
    const runtime = new CordisToolRuntime([
      {
        description: 'Echo',
        execute: async (input) => input,
        inputSchema: { type: 'object' },
        name: 'a:echo',
      },
      { execute: async () => 'second', name: 'b:echo' },
    ]);
    try {
      expect(await runtime.list()).toEqual([
        { description: 'Echo', inputSchema: { type: 'object' }, name: 'a:echo' },
        { name: 'b:echo' },
      ]);
      const fiber = await runtime.withContext(async (ctx) => {
        expect(Context.is(ctx)).toBe(true);
        const plugin = ctx.plugin((child) => {
          child.on('qingzhou.tools.execute', async (request, next) => {
            request.input = { edited: true };
            return next();
          });
        });
        await plugin;
        return { dispose: () => plugin.dispose() };
      });
      expect(await runtime.execute('a:echo', 'original')).toEqual({ edited: true });
      await fiber.dispose();
      expect(await runtime.execute('a:echo', false)).toBe(false);
      await expect(runtime.execute('unknown:echo', {})).rejects.toThrow('CORDIS_TOOL_NOT_FOUND');
    } finally {
      await runtime.dispose();
    }
  });

  it('replaces actual providers, keeps catalogs private and closes the request on failure', async () => {
    const alice = new CordisToolRuntime([{ execute: async () => 'alice', name: 'shared:tool' }]);
    const bob = new CordisToolRuntime([{ execute: async () => 'bob', name: 'shared:tool' }]);
    try {
      await alice.reload([{ execute: async () => 'alice-v2', name: 'new:tool' }]);
      expect(await alice.list()).toEqual([{ name: 'new:tool' }]);
      expect(await bob.execute('shared:tool', null)).toBe('bob');
      await expect(alice.execute('shared:tool', null)).rejects.toThrow('CORDIS_TOOL_NOT_FOUND');
    } finally {
      await Promise.all([alice.dispose(), bob.dispose()]);
    }
    await expect(alice.list()).rejects.toThrow('CORDIS_PROFILE_LOADER_DISPOSED');
    const failure = new Error('adapter failed');
    const dispose = vi.spyOn(CordisToolRuntime.prototype, 'dispose');
    try {
      await expect(
        invokeNativeTool(
          {
            execute: async () => {
              throw failure;
            },
            name: 'failed:tool',
          },
          0,
        ),
      ).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      dispose.mockRestore();
    }
  });

  it('uses unambiguous names and rejects duplicate registrations', () => {
    expect(canonicalToolName('assets', 'generate')).toBe('assets:generate');
    expect(() => canonicalToolName('assets:other', 'generate')).toThrow('CORDIS_TOOL_INVALID_NAME');
    expect(
      () =>
        new CordisToolRuntime([
          { execute: async () => 1, name: 'duplicate' },
          { execute: async () => 2, name: 'duplicate' },
        ]),
    ).toThrow('CORDIS_TOOL_DUPLICATE_OR_INVALID');
  });
});
