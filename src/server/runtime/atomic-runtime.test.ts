import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../../../packages/cordis-kernel/src';
import { type AtomicPlugin, AtomicRuntime } from './atomic-runtime';

const scope = { userId: 'alice', sessionId: 'session-a' };
const plugin = (version: string): AtomicPlugin => ({
  id: 'example',
  version,
  operations: [
    {
      name: 'example.echo',
      description: 'Typed echo',
      input: z.object({ text: z.string() }).strict(),
      execute: ({ text }, ctx) => ({ text, userId: ctx.scope.userId, version }),
    },
  ],
});
describe('AtomicRuntime', () => {
  it('keeps trusted composition metadata separate from mutable catalog responses', async () => {
    const capability = plugin('1');
    capability.operations[0].agent = { contexts: ['example.intake'], maxCalls: 2 };
    const runtime = new AtomicRuntime([capability]);
    try {
      const [tool] = await runtime.catalog();
      tool.agent!.contexts.push('skills');
      expect((await runtime.catalog())[0].agent).toEqual({
        contexts: ['example.intake'],
        maxCalls: 2,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('mounts real Cordis tools, validates input and isolates trusted invocation context and audit history', async () => {
    const runtime = new AtomicRuntime([plugin('1')]);
    expect((await runtime.catalog())[0]).toMatchObject({
      name: 'example.echo',
      pluginVersion: '1',
      inputSchema: { type: 'object' },
    });
    await expect(runtime.invoke('example.echo', { text: 42 }, { scope })).rejects.toMatchObject({
      code: 'PRESENTATION_INVALID',
    });
    await expect(
      runtime.invoke('example.echo', { text: 'ok', scope: { userId: 'bob' } }, { scope }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_INVALID' });
    expect(await runtime.invoke('example.echo', { text: 'ok' }, { scope })).toEqual({
      text: 'ok',
      userId: 'alice',
      version: '1',
    });
    expect((await runtime.snapshot({ userId: 'bob', sessionId: 'session-b' })).operations).toEqual(
      [],
    );
    expect((await runtime.snapshot(scope)).plugins[0]).toMatchObject({
      state: 'active',
      id: 'example',
    });
    await runtime.dispose();
    await expect(runtime.invoke('example.echo', { text: 'ok' }, { scope })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
  it('pins running jobs, replaces idle plugin implementations and rejects aborted operations', async () => {
    const runtime = new AtomicRuntime([plugin('1')]);
    const release = await runtime.acquire('example');
    await expect(runtime.replace(plugin('2'))).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
    release();
    await runtime.replace(plugin('2'));
    expect(await runtime.invoke('example.echo', { text: 'new' }, { scope })).toMatchObject({
      version: '2',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.invoke('example.echo', { text: 'no' }, { scope, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'PRESENTATION_WORKER_CANCELLED' });
    await runtime.dispose();
  });

  it('adds and removes a non-presentation plugin dynamically, protecting job leases and allowing reinstallation', async () => {
    const runtime = new AtomicRuntime();
    let release: (() => void) | undefined;
    try {
      expect(await runtime.catalog()).toEqual([]);
      await runtime.add(plugin('1'));
      expect(await runtime.invoke('example.echo', { text: 'installed' }, { scope })).toMatchObject({
        text: 'installed',
        version: '1',
        userId: scope.userId,
      });
      release = await runtime.acquire('example');
      await expect(runtime.remove('example')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      expect(
        await runtime.invoke('example.echo', { text: 'still available' }, { scope }),
      ).toMatchObject({ version: '1' });
      release();
      release();
      await runtime.remove('example');
      expect(await runtime.catalog()).toEqual([]);
      await expect(
        runtime.invoke('example.echo', { text: 'uninstalled' }, { scope }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      await runtime.add(plugin('2'));
      expect(
        await runtime.invoke('example.echo', { text: 'reinstalled' }, { scope }),
      ).toMatchObject({ text: 'reinstalled', version: '2' });
      expect((await runtime.catalog())[0]).toMatchObject({
        name: 'example.echo',
        pluginVersion: '2',
      });
    } finally {
      release?.();
      await runtime.dispose();
    }
  });

  it('keeps an in-flight atomic invocation installed until its automatic lease is released', async () => {
    const runtime = new AtomicRuntime();
    let finish!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let result: Promise<unknown> | undefined;
    try {
      await runtime.add({
        id: 'example',
        version: '1',
        operations: [
          {
            name: 'example.wait',
            description: 'Wait for a bounded external operation',
            input: z.object({}).strict(),
            execute: async () => {
              entered();
              await gate;
              return 'complete';
            },
          },
        ],
      });
      result = runtime.invoke('example.wait', {}, { scope });
      await started;
      await expect(runtime.remove('example')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      finish();
      await expect(result).resolves.toBe('complete');
      await runtime.remove('example');
      await expect(runtime.invoke('example.wait', {}, { scope })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
    } finally {
      finish();
      await result?.catch(() => undefined);
      await runtime.dispose();
    }
  });

  it('keeps the previous implementation after a candidate partially registers then fails activation', async () => {
    const runtime = new AtomicRuntime([plugin('1')]);
    await runtime.catalog();
    const register = ToolRegistry.prototype.register;
    const activation = vi.spyOn(ToolRegistry.prototype, 'register').mockImplementation(function (
      this: ToolRegistry,
      context,
      definition,
    ) {
      if (definition.name === 'example.activationFailure')
        throw new Error('Candidate activation failed');
      return register.call(this, context, definition);
    });
    try {
      const candidate = plugin('2');
      candidate.operations.push({
        name: 'example.activationFailure',
        description: 'Simulated activation failure',
        input: z.object({}).strict(),
        execute: () => 'unreachable',
      });
      await expect(runtime.replace(candidate)).rejects.toMatchObject({
        code: 'PLUGIN_START_FAILED',
      });
      expect(
        await runtime.invoke('example.echo', { text: 'old implementation' }, { scope }),
      ).toMatchObject({ text: 'old implementation', version: '1' });
      expect(await runtime.catalog()).toEqual([
        expect.objectContaining({ name: 'example.echo', pluginVersion: '1' }),
      ]);
      await expect(
        runtime.invoke('example.activationFailure', {}, { scope }),
      ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' });
      activation.mockRestore();
      await runtime.replace(plugin('3'));
      expect(await runtime.invoke('example.echo', { text: 'recovered' }, { scope })).toMatchObject({
        version: '3',
      });
    } finally {
      activation.mockRestore();
      await runtime.dispose();
    }
  });

  it('bounds per-scope history and evicts the least recently active scope without affecting leases', async () => {
    const runtime = new AtomicRuntime([plugin('1')], {
      maxEventScopes: 2,
      maxEventsPerScope: 3,
    });
    const bob = { userId: 'bob', sessionId: 'session-b' };
    const charlie = { userId: 'charlie', sessionId: 'session-c' };
    const release = await runtime.acquire('example');
    try {
      await runtime.invoke('example.echo', { text: 'first' }, { scope });
      await runtime.invoke('example.echo', { text: 'second' }, { scope: bob });
      await runtime.invoke('example.echo', { text: 'recent' }, { scope });
      await runtime.invoke('example.echo', { text: 'new scope' }, { scope: charlie });
      expect((await runtime.snapshot(scope)).operations.map((event) => event.state)).toEqual([
        'completed',
        'started',
        'completed',
      ]);
      expect((await runtime.snapshot(bob)).operations).toEqual([]);
      expect((await runtime.snapshot(charlie)).operations).toHaveLength(2);
      await expect(runtime.remove('example')).rejects.toMatchObject({ code: 'PLUGIN_BUSY' });
      release();
      await runtime.remove('example');
    } finally {
      release();
      await runtime.dispose();
    }
  });

  it('can disable retained diagnostics while continuing to emit live operation events', async () => {
    const runtime = new AtomicRuntime([plugin('1')], { maxEventScopes: 0 });
    const onEvent = vi.fn();
    try {
      await runtime.invoke('example.echo', { text: 'live' }, { scope, onEvent });
      expect(onEvent.mock.calls.map(([event]) => event.state)).toEqual(['started', 'completed']);
      expect((await runtime.snapshot(scope)).operations).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
