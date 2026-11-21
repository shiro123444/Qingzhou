import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type AtomicPlugin, createAtomicRuntimeFromProfile } from './atomic-runtime';

const module = (version: string): AtomicPlugin => ({
  id: 'probe',
  operations: [
    {
      description: 'Probe',
      execute: (_, ctx) => ({ user: ctx.scope.userId, version }),
      input: z.object({}).strict(),
      name: 'probe.run',
    },
  ],
  version,
});

describe('atomic profile production assembly', () => {
  it('evaluates only selected trusted factories and revokes operations when unloaded', async () => {
    const selected = vi.fn(async () => module('lazy'));
    const unused = vi.fn(async () => module('unused'));
    const runtime = createAtomicRuntimeFromProfile({
      bundles: { base: { entries: [{ id: 'probe', use: 'selected' }] } },
      modules: { selected, unused },
      profile: { bundles: ['base'] },
    });
    try {
      expect(selected).not.toHaveBeenCalled();
      await runtime.catalog();
      expect(selected).toHaveBeenCalledTimes(1);
      expect(unused).not.toHaveBeenCalled();
      await runtime.remove('probe');
      expect(await runtime.catalog()).toEqual([]);
      await expect(
        runtime.invoke('probe.run', {}, { scope: { userId: 'alice', sessionId: 'one' } }),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    } finally {
      await runtime.dispose();
    }
  });

  it('does not run a queued factory after its owner is disposed', async () => {
    const load = vi.fn(() => module('1'));
    const runtime = createAtomicRuntimeFromProfile({
      bundles: { base: { entries: [{ id: 'probe', use: 'probe' }] } },
      modules: { probe: load },
      profile: { bundles: ['base'] },
    });
    await runtime.dispose();
    expect(load).not.toHaveBeenCalled();
  });
  it('selects module versions through the same profile contract while preserving trusted scope', async () => {
    const runtime = createAtomicRuntimeFromProfile({
      bundles: { base: { entries: [{ id: 'probe', use: 'v1' }] } },
      modules: { v1: module('1'), v2: module('2') },
      profile: {
        bundles: ['base'],
        patches: [{ entry: { id: 'probe', use: 'v2' }, op: 'replace' }],
      },
    });
    try {
      expect(await runtime.catalog()).toEqual([
        expect.objectContaining({ name: 'probe.run', pluginVersion: '2' }),
      ]);
      expect(
        await runtime.invoke('probe.run', {}, { scope: { sessionId: 'one', userId: 'alice' } }),
      ).toEqual({ user: 'alice', version: '2' });
    } finally {
      await runtime.dispose();
    }
  });
});
