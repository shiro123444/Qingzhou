import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CordisProfileLoader,
  describeProfile,
  LoadedProfile,
  type ProfileDefinition,
} from './loader';

const hosts: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
});

describe('trusted lazy native modules', () => {
  it('inspects metadata without loading code and imports only the selected modules', async () => {
    const release = vi.fn();
    const selected = vi.fn(() => ({
      apply(ctx: LoadedProfile['native']) {
        ctx.provide('lazy.value', 42);
        ctx.effect(() => release);
      },
    }));
    const unused = vi.fn(() => ({ apply() {} }));
    const definition: ProfileDefinition = {
      bundles: { main: { entries: [{ id: 'selected', use: 'selected' }] } },
      modules: {
        selected: { load: selected, manifest: { id: 'selected', version: '1' } },
        unused: { load: unused, manifest: { id: 'unused', version: '1' } },
      },
      profile: { bundles: ['main'] },
    };
    const catalog = describeProfile(definition);
    expect(selected).not.toHaveBeenCalled();
    expect(unused).not.toHaveBeenCalled();
    expect(catalog[0].manifest?.version).toBe('1');
    catalog[0].manifest!.version = 'changed';
    expect(definition.modules.selected.manifest?.version).toBe('1');
    const host = new LoadedProfile(definition);
    hosts.push(host);
    await host.ready;
    expect(host.native.get('lazy.value')).toBe(42);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
    await host.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resolves native service dependencies across asynchronously imported plugins', async () => {
    const host = new LoadedProfile({
      bundles: { main: { entries: ['consumer', 'provider'].map((id) => ({ id, use: id })) } },
      modules: {
        consumer: {
          load: async () => ({
            apply(ctx) {
              ctx.provide('lazy.derived', ctx.get('lazy.source'));
            },
            inject: ['lazy.source'],
          }),
          manifest: { id: 'consumer', requires: ['provider'], version: '1' },
        },
        provider: {
          load: async () => (ctx) => {
            ctx.provide('lazy.source', 7);
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    hosts.push(host);
    await host.ready;
    expect(host.native.get('lazy.derived')).toBe(7);
  });

  it('rejects missing and cyclic declared dependencies before loading any code', () => {
    const load = vi.fn(() => ({ apply() {} }));
    const definition: ProfileDefinition = {
      bundles: { main: { entries: ['a', 'b'].map((id) => ({ id, use: id })) } },
      modules: {
        a: { load, manifest: { id: 'a', requires: ['missing'], version: '1' } },
        b: { load, manifest: { id: 'b', requires: ['a'], version: '1' } },
      },
      profile: { bundles: ['main'] },
    };
    expect(() => new LoadedProfile(definition)).toThrow('CORDIS_PROFILE_DEPENDENCY_MISSING');
    definition.modules.a.manifest!.requires = ['b'];
    expect(() => new LoadedProfile(definition)).toThrow('CORDIS_PROFILE_DEPENDENCY_CYCLE');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the previous generation when a lazy replacement fails', async () => {
    const definition = (value: number): ProfileDefinition => ({
      bundles: { main: { entries: [{ id: 'value', use: 'value' }] } },
      modules: {
        value: {
          load: async () => (ctx) => {
            ctx.provide('lazy.value', value);
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    const host = new CordisProfileLoader(definition(1));
    hosts.push(host);
    expect(await host.run(async (ctx) => ctx.get('lazy.value'))).toBe(1);
    const replacement: ProfileDefinition = {
      ...definition(2),
      modules: {
        value: {
          load: async () => {
            throw new Error('chunk unavailable');
          },
        },
      },
    };
    await expect(host.reload(replacement)).rejects.toThrow('chunk unavailable');
    expect(await host.run(async (ctx) => ctx.get('lazy.value'))).toBe(1);
    await host.reload(definition(3));
    expect(await host.run(async (ctx) => ctx.get('lazy.value'))).toBe(3);
  });

  it('cleans up a module whose import finishes after disposal was requested', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn();
    const host = new LoadedProfile({
      bundles: { main: { entries: [{ id: 'late', use: 'late' }] } },
      modules: {
        late: {
          load: async () => {
            await gate;
            return (ctx) => {
              ctx.effect(() => cleanup);
            };
          },
        },
      },
      profile: { bundles: ['main'] },
    });
    hosts.push(host);
    const closing = host.dispose();
    finish();
    await closing;
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(host.run(async () => {})).rejects.toThrow('CORDIS_PROFILE_DISPOSED');
  });
});
