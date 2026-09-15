import { describe, expect, it } from 'vitest';
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
