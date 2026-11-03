// @vitest-environment node
import { Context } from '@lobechat/cordis-foundation';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformClient } from '@/server/services/bot/platforms';

import { CordisConnection } from './CordisConnection';

const createClient = () => ({
  id: 'wechat',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

describe('CordisConnection', () => {
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

  it('bounds an unresponsive SDK startup without a shutdown request', async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      client.start.mockImplementationOnce(() => new Promise(() => {}));
      const connection = new CordisConnection(client as unknown as PlatformClient);
      const rejected = expect(connection.ready).rejects.toThrow('startup interrupted');
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      await connection.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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
