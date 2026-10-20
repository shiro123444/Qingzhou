import { Context } from '@lobechat/cordis-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CordisProfileLoader, LoadedProfile, type ProfileDefinition } from './loader';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const roots: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => root.dispose()));
});
const definition = (value: string, cleanup = () => {}): ProfileDefinition => ({
  bundles: { base: { entries: [{ config: { value }, id: 'service', use: 'service' }] } },
  modules: {
    service: {
      plugin: {
        apply(ctx: Context, config: { value: string }) {
          ctx.provide('profile.test.value', config.value);
          ctx.effect(() => cleanup);
        },
      },
    },
  },
  profile: { bundles: ['base'] },
});

describe('native profile loader', () => {
  it('waits for nested native providers without promoting a pending consumer', async () => {
    const gate = deferred();
    const childEntered = deferred();
    const loaded = new LoadedProfile({
      bundles: { main: { entries: ['consumer', 'provider'].map((id) => ({ id, use: id })) } },
      modules: {
        consumer: {
          plugin: {
            apply(ctx) {
              ctx.provide('derived', ctx.get('source'));
            },
            inject: ['source'],
          },
        },
        provider: {
          plugin: (ctx) => {
            ctx.plugin(async (child) => {
              childEntered.resolve();
              await gate.promise;
              child.provide('source', 42);
            });
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    roots.push(loaded);
    try {
      await childEntered.promise;
      gate.resolve();
      await loaded.ready;
      expect(loaded.native.get('derived')).toBe(42);
    } finally {
      gate.resolve();
      await loaded.dispose();
    }
  });
  it('drains a three-level asynchronous dependency chain before checking activation', async () => {
    const source = deferred();
    const middle = deferred();
    const consumer = deferred();
    const middleEntered = deferred();
    const consumerEntered = deferred();
    const loaded = new LoadedProfile({
      bundles: {
        main: { entries: ['consumer', 'middle', 'source'].map((id) => ({ id, use: id })) },
      },
      modules: {
        consumer: {
          plugin: {
            async apply(ctx) {
              consumerEntered.resolve();
              await consumer.promise;
              ctx.provide('result', ctx.get('middle'));
            },
            inject: ['middle'],
          },
        },
        middle: {
          plugin: {
            async apply(ctx) {
              middleEntered.resolve();
              await middle.promise;
              ctx.provide('middle', ctx.get('source'));
            },
            inject: ['source'],
          },
        },
        source: {
          plugin: async (ctx) => {
            await source.promise;
            ctx.provide('source', 42);
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    roots.push(loaded);
    try {
      source.resolve();
      await middleEntered.promise;
      middle.resolve();
      await consumerEntered.promise;
      consumer.resolve();
      await loaded.ready;
      expect(loaded.native.get('result')).toBe(42);
    } finally {
      source.resolve();
      middle.resolve();
      consumer.resolve();
      await loaded.dispose();
    }
  });
  it('activates consumers even when their provider appears later in the bundle', async () => {
    const loaded = new LoadedProfile({
      bundles: {
        main: {
          entries: [
            { id: 'consumer', use: 'consumer' },
            { id: 'provider', use: 'provider' },
          ],
        },
      },
      modules: {
        consumer: {
          plugin: {
            apply(ctx) {
              ctx.provide('derived', ctx.get('source'));
            },
            inject: ['source'],
          },
        },
        provider: {
          plugin: async (ctx) => {
            await Promise.resolve();
            ctx.provide('source', 42);
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    roots.push(loaded);
    await loaded.ready;
    expect(loaded.native.get('derived')).toBe(42);
  });
  it('uses real services and keeps accepted old calls alive across profile replacement', async () => {
    const gate = deferred();
    const entered = deferred();
    let cleaned = 0;
    const loader = new CordisProfileLoader(
      definition('old', () => {
        cleaned++;
      }),
    );
    roots.push(loader);
    const oldCall = loader.run(async (ctx) => {
      expect(Context.is(ctx)).toBe(true);
      entered.resolve();
      await gate.promise;
      return ctx.get('profile.test.value');
    });
    let reloading: Promise<void> | undefined;
    try {
      await entered.promise;
      reloading = loader.reload(definition('new'));
      await vi.waitFor(async () => {
        expect(await loader.run(async (ctx) => ctx.get('profile.test.value'))).toBe('new');
      });
      expect(cleaned).toBe(0);
      gate.resolve();
      expect(await oldCall).toBe('old');
      await reloading;
      expect(cleaned).toBe(1);
      expect(await loader.run(async (ctx) => ctx.get('profile.test.value'))).toBe('new');
    } finally {
      gate.resolve();
      await oldCall;
      await reloading;
    }
  });

  it('rolls back a failed candidate without changing the selected generation', async () => {
    const loader = new CordisProfileLoader(definition('old'));
    roots.push(loader);
    const failure = new Error('startup failed');
    const candidate = definition('new');
    candidate.modules = {
      service: {
        plugin: () => {
          throw failure;
        },
      },
    };
    await expect(loader.reload(candidate)).rejects.toBe(failure);
    expect(await loader.run(async (ctx) => ctx.get('profile.test.value'))).toBe('old');
  });

  it('rejects missing dependency activation and unregistered modules', async () => {
    const candidate = definition('pending');
    candidate.modules = { service: { plugin: { apply() {}, inject: ['never.provided'] } } };
    const loaded = new LoadedProfile(candidate);
    roots.push(loaded);
    await expect(loaded.ready).rejects.toThrow('CORDIS_PROFILE_PLUGIN_INACTIVE');
    expect(() => new LoadedProfile({ ...candidate, modules: {} })).toThrow(
      'CORDIS_PROFILE_MODULE_NOT_FOUND',
    );
  });

  it('serializes reloads and rejects new work after idempotent teardown', async () => {
    const loader = new CordisProfileLoader(definition('one'));
    roots.push(loader);
    await Promise.all([loader.reload(definition('two')), loader.reload(definition('three'))]);
    expect(await loader.run(async (ctx) => ctx.get('profile.test.value'))).toBe('three');
    const closing = loader.dispose();
    expect(loader.dispose()).toBe(closing);
    await closing;
    await expect(loader.run(async () => 1)).rejects.toThrow('CORDIS_PROFILE_LOADER_DISPOSED');
    await expect(loader.reload(definition('four'))).rejects.toThrow(
      'CORDIS_PROFILE_LOADER_DISPOSED',
    );
  });
});
