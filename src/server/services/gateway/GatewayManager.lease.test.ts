// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformClient, PlatformDefinition } from '@/server/services/bot/platforms/types';

import { GatewayManager } from './GatewayManager';

const { providers, lookup, redis, leases } = vi.hoisted(() => ({
  providers: vi.fn(),
  lookup: vi.fn(),
  redis: { eval: vi.fn() },
  leases: new Map<string, { owner: string; expires: number }>(),
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));
vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: Object.assign(
    vi.fn(() => ({ findEnabledByApplicationId: lookup })),
    {
      findEnabledByPlatform: providers,
    },
  ),
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@/server/modules/AgentRuntime/redis', () => ({ getAgentRuntimeRedisClient: () => redis }));

describe('GatewayManager installation ownership', () => {
  const managers: GatewayManager[] = [];
  const contexts: Array<Parameters<PlatformDefinition['clientFactory']['createClient']>[1]> = [];
  let factory: ReturnType<typeof vi.fn>;
  const provider = { applicationId: 'app', credentials: { token: 'first' } };
  const createManager = (platform = 'wechat') => {
    const manager = new GatewayManager({
      definitions: [
        {
          id: platform,
          connectionMode: 'polling',
          schema: [],
          clientFactory: { createClient: factory },
        } as unknown as PlatformDefinition,
      ],
    });
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    leases.clear();
    contexts.length = 0;
    providers.mockResolvedValue([provider]);
    lookup.mockResolvedValue(provider);
    redis.eval.mockImplementation(async (_script, _count, key, action, owner, ttl) => {
      const stored = leases.get(key);
      const held = stored && stored.expires > Date.now() ? stored : undefined;
      if (action === 'acquire') {
        if (held) return 0;
        leases.set(key, { owner, expires: Date.now() + ttl });
        return 1;
      }
      if (!held || held.owner !== owner) return 0;
      if (action === 'release') return Number(leases.delete(key));
      if (action === 'renew') {
        held.expires = Date.now() + ttl;
        return 1;
      }
      throw new Error('Unexpected lease command');
    });
    factory = vi.fn((_config, context) => {
      contexts.push(context);
      return {
        id: 'wechat',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      } as unknown as PlatformClient;
    });
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stop()));
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts only one replica and lets a standby take over after orderly release', async () => {
    const first = createManager();
    const standby = createManager();
    await Promise.all([first.start(), standby.start()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect([first.hasClient('wechat', 'app'), standby.hasClient('wechat', 'app')]).toEqual([
      true,
      false,
    ]);
    await first.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(standby.hasClient('wechat', 'app')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('also fences personal QQ sockets across replicas', async () => {
    const first = createManager('napcat');
    const standby = createManager('napcat');
    await Promise.all([first.start(), standby.start()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(contexts[0].assertConnectionHeld).toBeTypeOf('function');
    await first.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(standby.hasClient('napcat', 'app')).toBe(true);
  });

  it('reconciles remote configuration changes and disables without reopening', async () => {
    const manager = createManager();
    await manager.start();
    const first = factory.mock.results[0].value as PlatformClient;
    providers.mockResolvedValue([{ ...provider, credentials: { token: 'rotated' } }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1][0].credentials).toEqual({ token: 'rotated' });
    const replacement = factory.mock.results[1].value as PlatformClient;
    providers.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replacement.stop).toHaveBeenCalledTimes(1);
    expect(manager.hasClient('wechat', 'app')).toBe(false);
  });

  it('reports a remote owner as queued without disrupting it', async () => {
    const first = createManager();
    const other = createManager();
    await first.start();
    await expect(other.startClient('wechat', 'app', 'user')).resolves.toBe('queued');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.hasClient('wechat', 'app')).toBe(true);
  });

  it('keeps a transport alive when only identity policy and row timestamps change', async () => {
    const manager = createManager();
    await manager.start();
    const first = factory.mock.results[0].value as PlatformClient;
    providers.mockResolvedValue([
      {
        ...provider,
        settings: { channelIdentity: { requireBinding: true, revision: 'new-proof' } },
        updatedAt: new Date(),
      },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.hasClient('wechat', 'app')).toBe(true);
  });

  it('retries failed revoked cleanup during reconciliation before replacing the transport', async () => {
    const manager = createManager();
    await manager.start();
    const first = factory.mock.results[0].value as PlatformClient;
    vi.mocked(first.stop).mockRejectedValueOnce(new Error('closing'));
    leases.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.hasClient('wechat', 'app')).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.stop).toHaveBeenCalledTimes(2);
    expect(manager.hasClient('wechat', 'app')).toBe(true);
  });

  it('interrupts a pending SDK start immediately after ownership loss', async () => {
    let finishStart!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    factory.mockImplementationOnce((_config, context) => {
      contexts.push(context);
      return {
        id: 'wechat',
        stop,
        start: async () => {
          entered();
          await new Promise<void>((resolve) => {
            finishStart = resolve;
          });
          context.assertConnectionHeld();
        },
      };
    });
    const manager = createManager();
    const mounting = manager.startClient('wechat', 'app', 'user');
    const rejection = expect(mounting).rejects.toThrow('startup interrupted');
    await started;
    leases.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).toHaveBeenCalled();
    expect(() => contexts[0].assertConnectionHeld?.()).toThrow('lease lost');
    finishStart();
    await rejection;
    expect(manager.hasClient('wechat', 'app')).toBe(false);
    expect(leases.size).toBe(0);
  });

  it('does not let delayed old-owner cleanup dispose a replacement generation', async () => {
    const manager = createManager();
    await manager.start();
    await vi.advanceTimersByTimeAsync(9000);
    let finishLookup!: (value: typeof provider) => void;
    let entered!: () => void;
    const looking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    lookup.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        finishLookup = resolve;
      });
    });
    const rotating = manager.startClient('wechat', 'app', 'user');
    await looking;
    leases.clear();
    await vi.advanceTimersByTimeAsync(1000);
    finishLookup(provider);
    await expect(rotating).resolves.toBe('started');
    await vi.advanceTimersByTimeAsync(0);
    const replacement = factory.mock.results[1].value as PlatformClient;
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(manager.hasClient('wechat', 'app')).toBe(true);
  });
});
