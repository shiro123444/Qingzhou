import { describe, expect, it } from 'vitest';

import { CordisAtomicHost, type CordisServicePluginManifest } from './cordis-atomic-host';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const service = (value: string): CordisServicePluginManifest => ({
  id: 'workspace',
  version: value,
  kind: 'capability',
  apply(ctx) {
    ctx.provide('workspace', { value });
  },
});

describe('Cordis atomic host services', () => {
  it('distinguishes a provided undefined value from an absent service', async () => {
    const host = new CordisAtomicHost();
    try {
      const provider = await host.mount({
        id: 'placeholder',
        version: '1',
        kind: 'capability',
        apply(ctx) {
          ctx.provide('placeholder', undefined);
        },
      });
      expect(host.context.get('placeholder')).toBeUndefined();
      expect(host.context.has('placeholder')).toBe(true);
      await provider.dispose();
      expect(host.context.has('placeholder')).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it('publishes the real registry as a lifecycle-owned typed service', async () => {
    const host = new CordisAtomicHost();
    try {
      expect(host.context.get('cordis.tools')).toBe(host.tools);
      const consumer = await host.mount({
        id: 'consumer',
        version: '1',
        kind: 'capability',
        inject: ['cordis.tools'],
        apply(ctx) {
          ctx.get('cordis.tools')!.register(ctx, {
            name: 'consumer.run',
            description: 'run',
            inputSchema: {},
            execute: () => 'ok',
          });
        },
      });
      await expect(host.tools.execute('consumer.run', {}, host.context)).resolves.toBe('ok');
      await consumer.dispose();
      expect(host.tools.list()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('hides a provider while setup is still pending', async () => {
    const host = new CordisAtomicHost();
    const started = deferred();
    const gate = deferred();
    const mounting = host.mount({
      id: 'delayed',
      version: '1',
      kind: 'capability',
      async apply(ctx) {
        ctx.provide('workspace', { value: 'ready' });
        started.resolve();
        await gate.promise;
      },
    });
    try {
      await started.promise;
      expect(host.context.has('workspace')).toBe(false);
      gate.resolve();
      await mounting;
      expect(host.context.get('workspace')).toEqual({ value: 'ready' });
    } finally {
      gate.resolve();
      await mounting;
      await host.dispose();
    }
  });

  it('lets Cordis unload and restart dependent tools when their provider changes', async () => {
    const host = new CordisAtomicHost();
    const restarted = deferred();
    let runs = 0;
    let cleanups = 0;
    try {
      const provider = await host.mount(service('v1'));
      const consumer = await host.mount({
        id: 'reader',
        version: '1',
        kind: 'capability',
        inject: ['workspace'],
        apply(ctx) {
          runs += 1;
          const workspace = ctx.get<{ value: string }>('workspace')!;
          host.tools.register(ctx, {
            name: 'reader.value',
            description: 'read workspace',
            inputSchema: {},
            execute: () => workspace.value,
          });
          ctx.effect(() => () => {
            cleanups += 1;
          });
          if (runs === 2) restarted.resolve();
        },
      });
      await expect(host.tools.execute('reader.value', {}, host.context)).resolves.toBe('v1');
      await provider.dispose();
      expect(consumer.state).toBe('pending');
      expect(cleanups).toBe(1);
      expect(host.tools.list()).toEqual([]);
      const replacement = await host.mount(service('v2'));
      await restarted.promise;
      await expect(host.tools.execute('reader.value', {}, host.context)).resolves.toBe('v2');
      await consumer.dispose();
      await replacement.dispose();
      await host.mount(service('v3'));
      expect(consumer.state).toBe('disposed');
      expect(runs).toBe(2);
      expect(cleanups).toBe(2);
      expect(host.tools.list()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('isolates declared services across scopes while sharing host services', async () => {
    const host = new CordisAtomicHost({ scopedServices: ['workspace'] });
    try {
      const a = host.context.withScope('A');
      const b = host.context.withScope('B');
      const ownerA = await a.plugin(service('A'));
      const ownerB = await b.plugin(service('B'));
      expect(a.get('workspace')).toEqual({ value: 'A' });
      expect(b.get('workspace')).toEqual({ value: 'B' });
      expect(host.context.get('workspace')).toBeUndefined();
      expect(host.context.withScope('A').get('workspace')).toEqual({ value: 'A' });
      expect(a.withScope('B').get('workspace')).toEqual({ value: 'B' });
      expect(a.get('cordis.tools')).toBe(host.tools);
      expect(b.get('cordis.tools')).toBe(host.tools);
      await ownerA.dispose();
      expect(a.has('workspace')).toBe(false);
      expect(b.get('workspace')).toEqual({ value: 'B' });
      await ownerB.dispose();
    } finally {
      await host.dispose();
    }
  });

  it('keeps a committed candidate live after a dependency restart', async () => {
    const host = new CordisAtomicHost();
    const restarted = deferred();
    let activations = 0;
    try {
      const provider = await host.mount(service('v1'));
      const candidate = await host.mount(
        {
          id: 'candidate',
          version: '2',
          kind: 'capability',
          inject: ['workspace'],
          apply(ctx) {
            const value = ctx.get<{ value: string }>('workspace')!.value;
            host.tools.register(ctx, {
              name: 'candidate.read',
              description: 'read',
              inputSchema: {},
              execute: () => value,
            });
            activations += 1;
            if (activations === 2) restarted.resolve();
          },
        },
        true,
      );
      expect(host.tools.list()).toEqual([]);
      host.commit(candidate);
      await provider.dispose();
      await host.mount(service('v2'));
      await restarted.promise;
      expect(candidate.context.isStaging).toBe(false);
      await expect(host.tools.execute('candidate.read', {}, host.context)).resolves.toBe('v2');
    } finally {
      await host.dispose();
    }
  });

  it('rejects staged service publication without exposing or replacing services', async () => {
    const host = new CordisAtomicHost();
    try {
      await host.mount(service('live'));
      await expect(host.mount(service('candidate'), true)).rejects.toMatchObject({
        code: 'CORDIS_STAGED_SERVICE_UNSUPPORTED',
      });
      await expect(
        host.mount(
          {
            id: 'new-service',
            version: '1',
            kind: 'capability',
            apply(ctx) {
              ctx.provide('candidate-only', {});
            },
          },
          true,
        ),
      ).rejects.toMatchObject({ code: 'CORDIS_STAGED_SERVICE_UNSUPPORTED' });
      expect(host.context.get('workspace')).toEqual({ value: 'live' });
      expect(host.context.has('candidate-only')).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it('prevents reads and new scopes after shutdown', async () => {
    const host = new CordisAtomicHost({ scopedServices: ['workspace'] });
    await host.dispose();
    for (const call of [
      () => host.context.get('cordis.tools'),
      () => host.context.has('workspace'),
      () => host.context.withScope('new'),
    ])
      expect(call).toThrow(expect.objectContaining({ code: 'CORDIS_ATOMIC_HOST_DISPOSED' }));
  });
});
