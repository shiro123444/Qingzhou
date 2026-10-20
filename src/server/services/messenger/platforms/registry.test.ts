// @vitest-environment node
import { Context } from '@lobechat/cordis-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MESSENGER_REGISTRY_CATALOG_SERVICE } from './cordis';
import { messengerPlatformRegistry } from './index';
import { MessengerPlatformRegistry } from './registry';

const buildDefinition = (overrides: Partial<any> = {}) => ({
  connectionMode: 'webhook' as const,
  createBinder: vi.fn(() => ({ id: 'binder' }) as any),
  id: 'slack' as const,
  name: 'Slack',
  oauth: { exchangeCode: vi.fn() },
  webhookGate: { preprocess: vi.fn() },
  ...overrides,
});

describe('MessengerPlatformRegistry', () => {
  const registries: MessengerPlatformRegistry[] = [];

  const createRegistry = (): MessengerPlatformRegistry => {
    const registry = new MessengerPlatformRegistry();
    registries.push(registry);
    return registry;
  };

  afterEach(async () => {
    for (const registry of registries.splice(0)) {
      try {
        await registry.dispose();
      } catch {
        // Teardown failures must not mask the test result.
      }
    }
  });

  it('register / getPlatform round-trips a definition', () => {
    const reg = createRegistry();
    const def = buildDefinition() as any;
    expect(reg.register(def)).toBe(reg);
    expect(reg.getPlatform('slack')).toBe(def);
  });

  it('throws when registering a duplicate platform id', () => {
    const reg = createRegistry();
    reg.register(buildDefinition() as any);
    expect(() => reg.register(buildDefinition() as any)).toThrow(/already registered/);
  });

  it('listPlatforms returns every registered definition', () => {
    const reg = createRegistry();
    reg.register(buildDefinition({ id: 'slack', name: 'Slack' }) as any);
    reg.register(buildDefinition({ id: 'telegram', name: 'Telegram' }) as any);
    expect(reg.listPlatforms().map((d) => d.id)).toEqual(['slack', 'telegram']);
  });

  it('listSerializedPlatforms strips runtime-only fields (createBinder, oauth, webhookGate)', () => {
    const reg = createRegistry();
    reg.register(buildDefinition() as any);
    const [serialized] = reg.listSerializedPlatforms();
    expect(serialized).toEqual({ connectionMode: 'webhook', id: 'slack', name: 'Slack' });
    expect((serialized as any).createBinder).toBeUndefined();
    expect((serialized as any).oauth).toBeUndefined();
    expect((serialized as any).webhookGate).toBeUndefined();
  });

  it('createBinder dispatches to the registered factory with the credentials', () => {
    const reg = createRegistry();
    const factory = vi.fn(() => ({ kind: 'binder' }) as any);
    reg.register(buildDefinition({ createBinder: factory }) as any);
    const creds = {
      applicationId: 'A',
      botToken: 'b',
      installationKey: 'slack:T',
      metadata: {},
      platform: 'slack' as const,
      tenantId: 'T',
    };
    const binder = reg.createBinder(creds);
    expect(factory).toHaveBeenCalledWith(creds);
    expect(binder).toEqual({ kind: 'binder' });
  });

  it('createBinder returns null for unknown platforms', () => {
    const reg = createRegistry();
    const binder = reg.createBinder({
      applicationId: 'A',
      botToken: 'b',
      installationKey: 'unknown:x',
      metadata: {},
      platform: 'discord' as any,
      tenantId: 'x',
    });
    expect(binder).toBeNull();
  });

  it('assembles each platform as its own native generation and exposes only ids on the registry root', () => {
    const reg = createRegistry();
    expect(Context.is(reg.native)).toBe(true);

    const def = buildDefinition() as any;
    reg.register(def);

    // The registry root carries a metadata facade (ids) — never definitions.
    const catalog = reg.native.get('messenger.registry.catalog');
    expect(catalog?.listPlatformIds()).toEqual(['slack']);
    expect(reg.native.get('messenger.platform.definition')).toBeUndefined();

    // The definition itself is held by the generation's own native root.
    expect(reg.getPlatform('slack')).toBe(def);
  });

  it('makes synchronously registered definitions readable without awaiting anything', () => {
    const reg = createRegistry();
    const def = buildDefinition({ name: 'Sync Slack' }) as any;

    reg.register(def);

    // No await between register and read: this is the synchronous contract.
    expect(reg.getPlatform('slack')).toBe(def);
    expect(reg.listPlatforms().map((d) => d.name)).toEqual(['Sync Slack']);
  });

  it('attaches a generation on mountPlatform and keeps reading the native service', async () => {
    const reg = createRegistry();
    const def = buildDefinition({ name: 'Slack v1' }) as any;
    reg.register(def);

    await reg.mountPlatform('slack');
    await reg.ready();

    expect(reg.getPlatform('slack')).toBe(def);
    expect(reg.listPlatforms().map((d) => d.name)).toEqual(['Slack v1']);
  });

  it('removes an unmounted platform from the readable set and restores it on mount', async () => {
    const reg = createRegistry();
    reg.register(buildDefinition() as any);
    await reg.mountPlatform('slack');

    await reg.unmountPlatform('slack');

    expect(reg.getPlatform('slack')).toBeUndefined();
    expect(reg.listPlatforms()).toHaveLength(0);
    expect(reg.listSerializedPlatforms()).toHaveLength(0);

    await reg.mountPlatform('slack');

    expect(reg.getPlatform('slack')).toBeDefined();
    expect(reg.listPlatforms()).toHaveLength(1);
  });

  it('swaps in a reloaded definition and serializes concurrent changes per platform', async () => {
    const reg = createRegistry();
    reg.register(buildDefinition({ name: 'v1' }) as any);
    await reg.mountPlatform('slack');

    const v2 = buildDefinition({ name: 'v2' }) as any;
    const v3 = buildDefinition({ name: 'v3' }) as any;

    const first = reg.reloadPlatform('slack', v2);
    const second = reg.reloadPlatform('slack', v3);
    await Promise.all([first, second]);

    // Serialized per platform: the last requested definition wins deterministically.
    expect(reg.getPlatform('slack')).toBe(v3);
    expect(reg.listPlatforms().map((d) => d.name)).toEqual(['v3']);
  });

  it('keeps the previous definition when a reload candidate fails, and rejects id mismatch', async () => {
    const reg = createRegistry();
    const current = buildDefinition({ name: 'current' }) as any;
    reg.register(current);
    await reg.mountPlatform('slack');

    // A definition that throws while the candidate generation is being created.
    let reads = 0;
    const poisoned = {
      ...buildDefinition({ name: 'poisoned' }),
      get id() {
        reads += 1;
        if (reads > 1) throw new Error('candidate exploded');
        return 'slack';
      },
    } as any;

    await expect(reg.reloadPlatform('slack', poisoned)).rejects.toThrow('candidate exploded');
    expect(reg.getPlatform('slack')).toBe(current);
    expect(reg.listPlatforms().map((d) => d.name)).toEqual(['current']);

    await expect(
      reg.reloadPlatform('slack', buildDefinition({ id: 'telegram' }) as any),
    ).rejects.toThrow(/id mismatch/);
    expect(reg.getPlatform('slack')).toBe(current);
  });

  it('rejects registration and reads after disposal, and dispose is idempotent', async () => {
    const reg = createRegistry();
    reg.register(buildDefinition() as any);

    const first = reg.dispose();
    const second = reg.dispose();
    expect(first).toBe(second);
    await first;

    expect(() => reg.register(buildDefinition() as any)).toThrowError(
      expect.objectContaining({ code: 'CORDIS_REGISTRY_CLOSED' }),
    );
    expect(() => reg.getPlatform('slack')).toThrowError(
      expect.objectContaining({ code: 'CORDIS_REGISTRY_CLOSED' }),
    );
    expect(() => reg.listPlatforms()).toThrowError(
      expect.objectContaining({ code: 'CORDIS_REGISTRY_CLOSED' }),
    );
    await expect(reg.mountPlatform('slack')).rejects.toMatchObject({
      code: 'CORDIS_REGISTRY_CLOSED',
    });
    await expect(reg.reloadPlatform('slack')).rejects.toMatchObject({
      code: 'CORDIS_REGISTRY_CLOSED',
    });
  });
});

describe('messengerPlatformRegistry singleton', () => {
  it('registers slack, telegram, and discord on import', () => {
    const ids = messengerPlatformRegistry.listPlatforms().map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['slack', 'telegram', 'discord']));
  });

  it('uses the native Cordis backed registry and is readable synchronously', () => {
    expect(messengerPlatformRegistry).toBeInstanceOf(MessengerPlatformRegistry);
    expect(Context.is(messengerPlatformRegistry.native)).toBe(true);

    // No await: built-ins must be readable on first request.
    expect(messengerPlatformRegistry.getPlatform('slack')).toBeDefined();
    expect(messengerPlatformRegistry.native.get(MESSENGER_REGISTRY_CATALOG_SERVICE)).toBeDefined();
    expect(messengerPlatformRegistry.listSerializedPlatforms().length).toBeGreaterThanOrEqual(3);
  });
});
