// @vitest-environment node
import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONNECTION_LEASE_SCRIPT, ConnectionLease } from './ConnectionLease';
import { getBotRuntimeStatus, updateBotRuntimeStatus } from './runtimeStatus';

const redisUrl = process.env.CHANNEL_TEST_REDIS_URL;
if (redisUrl) {
  const url = new URL(redisUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/15' ||
    !url.port ||
    url.port === '6379'
  ) {
    throw new Error('Channel lease tests require a dedicated local Redis database 15');
  }
}

describe.skipIf(!redisUrl)('connection ownership (real isolated Redis)', () => {
  const redis = new Redis(redisUrl ?? 'redis://127.0.0.1:1/15', {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  const keys = new Set<string>();
  const leases: ConnectionLease[] = [];

  beforeAll(async () => {
    await redis.connect();
  });

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    if (keys.size) await redis.del(...keys);
    keys.clear();
  });

  afterAll(async () => {
    await redis.quit();
  });

  const acquire = async (runtimeKey: string, onLost = vi.fn()) => {
    const lease = await ConnectionLease.acquire(redis, runtimeKey, onLost);
    if (lease) {
      leases.push(lease);
      keys.add(lease.key);
    }
    return lease;
  };

  it('grants one owner when independent claims race', async () => {
    const runtimeKey = `qq:lease-test-${randomUUID()}`;
    const claims = await Promise.all(Array.from({ length: 6 }, () => acquire(runtimeKey)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims.find(Boolean)!;
    expect(await redis.get(owner.key)).toBe(owner.owner);
    expect(await redis.pttl(owner.key)).toBeGreaterThan(0);
    expect(await redis.pttl(owner.key)).toBeLessThanOrEqual(30_000);
  });

  it('allows expiry takeover while fencing stale renewal and release', async () => {
    const runtimeKey = `wechat:lease-test-${randomUUID()}`;
    const onLost = vi.fn();
    const previous = (await acquire(runtimeKey, onLost))!;
    await redis.pexpire(previous.key, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacement = (await acquire(runtimeKey))!;
    expect(replacement).toBeDefined();
    expect(replacement.owner).not.toBe(previous.owner);

    const renewed = await redis.eval(
      CONNECTION_LEASE_SCRIPT,
      1,
      previous.key,
      'renew',
      previous.owner,
      30_000,
    );
    expect(renewed).toBe(0);
    const previousInternal = previous as unknown as {
      renew: () => void;
      renewing?: Promise<void>;
    };
    previousInternal.renew();
    await previousInternal.renewing;
    expect(previous.isHeld).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await previous.release();
    expect(await redis.get(replacement.key)).toBe(replacement.owner);
    expect(replacement.isHeld).toBe(true);
  });

  it('does not let stale-owner runtime state overwrite its replacement', async () => {
    const applicationId = `lease-test-${randomUUID()}`;
    const runtimeKey = `feishu:${applicationId}`;
    keys.add(`bot:runtime-status:${runtimeKey}`);
    const previous = (await acquire(runtimeKey))!;
    await redis.del(previous.key);
    const replacement = (await acquire(runtimeKey))!;
    await updateBotRuntimeStatus(
      { applicationId, platform: 'feishu', status: 'connected' },
      { connectionLease: replacement, redisClient: redis, ttlMs: 30_000 },
    );
    // The old process still considers itself held locally. Redis must fence it.
    expect(previous.isHeld).toBe(true);
    await updateBotRuntimeStatus(
      { applicationId, platform: 'feishu', status: 'disconnected' },
      { connectionLease: previous, redisClient: redis },
    );
    const state = await getBotRuntimeStatus('feishu', applicationId, redis);
    expect(state.status).toBe('connected');
    expect(await redis.pttl(`bot:runtime-status:${runtimeKey}`)).toBeGreaterThan(0);
  });
});
