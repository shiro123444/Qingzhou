// @vitest-environment node
import { Context } from '@lobechat/cordis-foundation';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformClient } from '@/server/services/bot/platforms';

import type { ConnectionLease } from './ConnectionLease';
import { CordisConnection } from './CordisConnection';

const createClient = () => ({
  id: 'wechat',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

describe('CordisConnection', () => {
  it('disposes a pending import without waiting and never starts its late client', async () => {
    const client = createClient();
    let resolveLoad!: (client: PlatformClient) => void;
    const load = vi.fn(
      () =>
        new Promise<PlatformClient>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const release = vi.fn().mockResolvedValue(undefined);
    const lease = {
      assertHeld: vi.fn(),
      release,
      stopAccepting: vi.fn(),
    } as unknown as ConnectionLease;
    const connection = new CordisConnection({ id: 'wechat', load }, lease);
    const rejected = expect(connection.ready).rejects.toThrow('startup interrupted');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await connection.dispose();
    await rejected;
    expect(release).toHaveBeenCalledOnce();
    expect(connection.context.fiber.getEffects()).toEqual([]);

    resolveLoad(client as unknown as PlatformClient);
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
    expect(client.start).not.toHaveBeenCalled();
  });

  it('cleans a late import that resolves while lease release is still pending', async () => {
    const client = createClient();
    let resolveLoad!: (client: PlatformClient) => void;
    let finishRelease!: () => void;
    const load = vi.fn(
      () =>
        new Promise<PlatformClient>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const lease = {
      assertHeld: vi.fn(),
      release,
      stopAccepting: vi.fn(),
    } as unknown as ConnectionLease;
    const connection = new CordisConnection({ id: 'wechat', load }, lease);
    const rejected = expect(connection.ready).rejects.toThrow('startup interrupted');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const disposing = connection.dispose();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    resolveLoad(client as unknown as PlatformClient);
    finishRelease();
    await disposing;
    await rejected;
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
    expect(client.start).not.toHaveBeenCalled();
  });

  it('rechecks ownership after loading before opening a transport', async () => {
    const client = createClient();
    const lease = {
      assertHeld: vi.fn(() => {
        throw new Error('lease lost');
      }),
      release: vi.fn().mockResolvedValue(undefined),
      stopAccepting: vi.fn(),
    } as unknown as ConnectionLease;
    const connection = new CordisConnection(
      {
        id: 'wechat',
        load: async () => client as unknown as PlatformClient,
      },
      lease,
    );
    await expect(connection.ready).rejects.toThrow('lease lost');
    await connection.dispose();
    expect(client.start).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it('releases the scope after an import failure', async () => {
    const load = vi.fn().mockRejectedValue(new Error('module unavailable'));
    const connection = new CordisConnection({ id: 'wechat', load });
    await expect(connection.ready).rejects.toThrow('module unavailable');
    await connection.dispose();
    expect(connection.context.fiber.getEffects()).toEqual([]);
  });

  it('disposes even when SDK startup never settles and cleans a late acquisition', async () => {
    const client = createClient();
    let finishStart!: () => void;
    let entered!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      entered = resolve;
    });
    client.start.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finishStart = resolve;
      });
    });
    const connection = new CordisConnection(client as unknown as PlatformClient);
    const rejected = expect(connection.ready).rejects.toThrow('startup interrupted');
    await acquiring;
    connection.prepareStop();
    await rejected;
    await connection.dispose();
    const stoppedBeforeLateStart = client.stop.mock.calls.length;
    finishStart();
    await vi.waitFor(() =>
      expect(client.stop.mock.calls.length).toBeGreaterThan(stoppedBeforeLateStart),
    );
    expect(connection.context.fiber.getEffects()).toEqual([]);
  });

  it.each(['import', 'transport'])(
    'bounds an unresponsive %s without a shutdown request',
    async (stage) => {
      vi.useFakeTimers();
      try {
        const client = createClient();
        client.start.mockImplementationOnce(() => new Promise(() => {}));
        const connection = new CordisConnection(
          stage === 'import'
            ? { id: 'wechat', load: () => new Promise<PlatformClient>(() => {}) }
            : (client as unknown as PlatformClient),
        );
        const rejected = expect(connection.ready).rejects.toThrow('startup interrupted');
        await vi.advanceTimersByTimeAsync(60_000);
        await rejected;
        await connection.dispose();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('owns transport cleanup through a real native Cordis plugin', async () => {
    const client = createClient();
    const connection = new CordisConnection(client as unknown as PlatformClient);
    await connection.ready;
    expect(Context.is(connection.context)).toBe(true);
    expect(connection.context.fiber.getEffects().length).toBeGreaterThan(0);
    await Promise.all([connection.dispose(), connection.dispose()]);
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(connection.context.fiber.getEffects()).toEqual([]);
  });

  it('reclaims a partially acquired transport after a falsy startup failure', async () => {
    const client = createClient();
    client.start.mockRejectedValueOnce(undefined);
    const connection = new CordisConnection(client as unknown as PlatformClient);
    await expect(connection.ready).rejects.toBeUndefined();
    await connection.dispose();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it('surfaces cleanup failures and permits a later cleanup retry', async () => {
    const client = createClient();
    client.stop.mockRejectedValueOnce(new Error('disconnect failed'));
    const connection = new CordisConnection(client as unknown as PlatformClient);
    await connection.ready;
    await expect(connection.dispose()).rejects.toThrow('disconnect failed');
    await connection.dispose();
    expect(client.stop).toHaveBeenCalledTimes(2);
  });
});
