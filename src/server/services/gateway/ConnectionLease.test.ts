// @vitest-environment node
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_LEASE_MS, CONNECTION_RENEW_MS, ConnectionLease } from './ConnectionLease';

function createRedis() {
  const entries = new Map<string, { expiresAt: number; owner: string }>();
  const evalCommand = vi.fn(
    async (
      _script: string,
      _count: number,
      key: string,
      action: string,
      owner: string,
      ttl: number,
    ): Promise<number> => {
      const entry = entries.get(key);
      if (entry && entry.expiresAt <= Date.now()) entries.delete(key);
      if (action === 'acquire') {
        if (entries.has(key)) return 0;
        entries.set(key, { expiresAt: Date.now() + ttl, owner });
        return 1;
      }
      if (entries.get(key)?.owner !== owner) return 0;
      if (action === 'release') entries.delete(key);
      if (action === 'renew') entries.set(key, { expiresAt: Date.now() + ttl, owner });
      return 1;
    },
  );
  return {
    client: { eval: evalCommand as unknown as Redis['eval'] },
    entries,
    eval: evalCommand,
  };
}

describe('ConnectionLease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('fails closed when Redis is unavailable', async () => {
    await expect(ConnectionLease.acquire(null, 'qq:app', vi.fn())).rejects.toThrow('require Redis');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('grants a concurrent installation claim to one owner', async () => {
    const redis = createRedis();
    const claims = await Promise.all([
      ConnectionLease.acquire(redis.client, 'qq:app', vi.fn()),
      ConnectionLease.acquire(redis.client, 'qq:app', vi.fn()),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const held = claims.find(Boolean)!;
    expect(held.isHeld).toBe(true);
    await held.release();
    expect(redis.entries.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews a held lease before its original deadline', async () => {
    const redis = createRedis();
    const lease = (await ConnectionLease.acquire(redis.client, 'qq:app', vi.fn()))!;
    await vi.advanceTimersByTimeAsync(CONNECTION_RENEW_MS * 4);
    expect(lease.isHeld).toBe(true);
    expect(redis.eval.mock.calls.filter((args) => args[3] === 'renew')).toHaveLength(4);
    await lease.release();
  });

  it('revokes ownership once when renewal is rejected', async () => {
    const redis = createRedis();
    const onLost = vi.fn();
    const lease = (await ConnectionLease.acquire(redis.client, 'wechat:app', onLost))!;
    redis.eval.mockResolvedValueOnce(0);
    await vi.advanceTimersByTimeAsync(CONNECTION_RENEW_MS);
    expect(lease.isHeld).toBe(false);
    expect(() => lease.assertHeld()).toThrow('lease lost');
    await vi.advanceTimersByTimeAsync(CONNECTION_LEASE_MS);
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('times out a hanging claim without starting a heartbeat', async () => {
    const redis = createRedis();
    let finish!: (result: number) => void;
    redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const claim = ConnectionLease.acquire(redis.client, 'qq:app', vi.fn());
    const rejected = expect(claim).rejects.toThrow('backend unavailable');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    finish(1);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not regain ownership after a timed-out renewal eventually succeeds', async () => {
    const redis = createRedis();
    const onLost = vi.fn();
    const lease = (await ConnectionLease.acquire(redis.client, 'feishu:app', onLost))!;
    let finish!: (result: number) => void;
    redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(CONNECTION_RENEW_MS + 5000);
    expect(lease.isHeld).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    finish(1);
    await vi.advanceTimersByTimeAsync(CONNECTION_LEASE_MS);
    expect(lease.isHeld).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('rejects an expired owner before a delayed event-loop timer can run', async () => {
    const redis = createRedis();
    const onLost = vi.fn();
    const lease = (await ConnectionLease.acquire(redis.client, 'wechat:app', onLost))!;
    vi.setSystemTime(Date.now() + CONNECTION_LEASE_MS + 1);
    expect(() => lease.assertHeld()).toThrow('lease lost');
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('rejects an acquisition response that arrives after its deadline during a pause', async () => {
    const redis = createRedis();
    redis.eval.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 5001);
      return 1;
    });
    await expect(ConnectionLease.acquire(redis.client, 'qq:app', vi.fn())).rejects.toThrow(
      'response expired',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins renewal before releasing its owner token and cancels its timer', async () => {
    const redis = createRedis();
    const onLost = vi.fn();
    const lease = (await ConnectionLease.acquire(redis.client, 'qq:app', onLost))!;
    let finish!: (result: number) => void;
    redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(CONNECTION_RENEW_MS);
    const releasing = lease.release();
    expect(redis.eval.mock.calls.some((args) => args[3] === 'release')).toBe(false);
    finish(1);
    await releasing;
    expect(redis.eval.mock.calls.at(-1)?.slice(2, 5)).toEqual([lease.key, 'release', lease.owner]);
    expect(lease.isHeld).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot remove the replacement owner when an expired owner releases', async () => {
    const redis = createRedis();
    const previous = (await ConnectionLease.acquire(redis.client, 'qq:app', vi.fn()))!;
    vi.setSystemTime(Date.now() + CONNECTION_LEASE_MS + 1);
    const replacement = (await ConnectionLease.acquire(redis.client, 'qq:app', vi.fn()))!;
    expect(replacement.owner).not.toBe(previous.owner);
    await previous.release();
    expect(redis.entries.get(replacement.key)?.owner).toBe(replacement.owner);
    await replacement.release();
  });
});
