// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { AgentState } from '@lobechat/agent-runtime';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CallbackDeliverySession, RedisCallbackLedger } from '@/server/services/bot/callbackLedger';

import { AgentStateManager } from '../AgentStateManager';
import * as redisRuntime from '../redis';

// Opt-in only: use a disposable LOCAL UNIX socket, never the application's REDIS_URL.
const socket = process.env.AGENT_TEST_REDIS_SOCKET;
if (socket && !socket.startsWith('/tmp/')) {
  throw new Error('Lease integration tests require an isolated /tmp/ Redis socket');
}

const state = (
  operationId: string,
  stepCount: number,
  status: AgentState['status'] = 'running',
): AgentState => ({
  cost: {
    calculatedAt: new Date().toISOString(),
    currency: 'USD',
    llm: { byModel: [], currency: 'USD', total: 0 },
    tools: { byTool: [], currency: 'USD', total: 0 },
    total: 0,
  },
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
  messages: [],
  metadata: {},
  operationId,
  status,
  stepCount,
  toolManifestMap: {},
  usage: {
    humanInteraction: {
      approvalRequests: 0,
      promptRequests: 0,
      selectRequests: 0,
      totalWaitingTimeMs: 0,
    },
    llm: { apiCalls: 0, processingTimeMs: 0, tokens: { input: 0, output: 0, total: 0 } },
    tools: { byTool: [], totalCalls: 0, totalTimeMs: 0 },
  },
});

describe.skipIf(!socket)('lease Lua against an isolated real Redis server', () => {
  let redis: Redis;
  let manager: AgentStateManager;

  beforeAll(async () => {
    redis = new Redis({
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      path: socket!,
    });
    await redis.connect();
    vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue(redis);
    manager = new AgentStateManager();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // No FLUSHDB/FLUSHALL: the caller owns the disposable server and its lifecycle.
    await redis?.quit();
  });

  it('grants exactly one owner under contention and fences renew/release', async () => {
    const operation = randomUUID();
    const claims = await Promise.all(
      Array.from({ length: 16 }, () => manager.acquireStepLease(operation, 0)),
    );
    const winners = claims.filter((lease) => lease !== null);
    expect(winners).toHaveLength(1);
    const owner = winners[0]!;
    const stale = { ...owner, ownerToken: randomUUID() };
    expect(await manager.renewStepLease(stale)).toBe(false);
    expect(await manager.releaseStepLease(stale)).toBe(false);
    expect(await manager.renewStepLease(owner)).toBe(true);
    expect(await manager.acquireStepLease(operation, 0)).toBeNull();
    expect(await manager.releaseStepLease(owner)).toBe(true);
  });

  it('does not let an expired owner delete or commit over its replacement', async () => {
    const operation = randomUUID();
    const stale = (await manager.acquireStepLease(operation, 0, 0.08))!;
    await delay(120);
    const current = (await manager.acquireStepLease(operation, 0))!;
    expect(current.ownerToken).not.toBe(stale.ownerToken);
    expect(await manager.releaseStepLease(stale)).toBe(false);
    expect(
      await manager.saveAgentStateWithLease(operation, state(operation, 1, 'error'), stale),
    ).toBe(false);
    expect(
      await manager.saveAgentStateWithLease(operation, state(operation, 1, 'done'), current),
    ).toBe(true);
    expect(await manager.loadAgentState(operation)).toMatchObject({ status: 'done', stepCount: 1 });
  });

  it('commits state, metadata, history and pending continuation atomically without step regression', async () => {
    const operation = randomUUID();
    const first = (await manager.acquireStepLease(operation, 0))!;
    await manager.saveAgentState(operation, state(operation, 0));
    const next = state(operation, 1);
    next.metadata = { _pendingNextStep: { operationId: operation, stepIndex: 1 } };
    const result = { events: [], executionTime: 10, newState: next, stepIndex: 0 };
    expect(await manager.saveStepResultWithLease(operation, result, first)).toBe(true);
    expect(await manager.loadAgentState(operation)).toMatchObject(next);
    expect(await manager.getOperationMetadata(operation)).toMatchObject({
      status: 'running',
      totalSteps: 1,
    });
    expect(await manager.getExecutionHistory(operation)).toHaveLength(1);
    expect(await manager.saveStepResultWithLease(operation, result, first)).toBe(false);
    const second = (await manager.acquireStepLease(operation, 1))!;
    expect(
      await manager.saveStepResultWithLease(
        operation,
        { ...result, newState: state(operation, 2, 'done'), stepIndex: 1 },
        second,
      ),
    ).toBe(true);
    expect(
      await manager.saveAgentStateWithLease(operation, state(operation, 1, 'error'), first),
    ).toBe(false);
    expect(await manager.getOperationMetadata(operation)).toMatchObject({
      status: 'done',
      totalSteps: 2,
    });
  });

  it('shares callback completion tombstones across backend instances', async () => {
    const body = {
      applicationId: 'app',
      operationId: randomUUID(),
      platformThreadId: 'qq:thread',
      type: 'completion' as const,
    };
    const first = await CallbackDeliverySession.begin(
      body,
      'fingerprint',
      new RedisCallbackLedger(redis),
    );
    expect(first).not.toBeNull();
    await expect(
      CallbackDeliverySession.begin(body, 'fingerprint', new RedisCallbackLedger(redis)),
    ).rejects.toMatchObject({ status: 'busy' });
    const send = vi.fn(async () => 'message-id');
    await first!.effect('chunk:0', send);
    await first!.complete();
    await first!.release();
    expect(
      await CallbackDeliverySession.begin(
        body,
        'different-hook-transport',
        new RedisCallbackLedger(redis),
      ),
    ).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });

  it('retains unknown callback message delivery instead of granting retry permission', async () => {
    const body = {
      applicationId: 'app',
      operationId: randomUUID(),
      platformThreadId: 'qq:thread',
      type: 'completion' as const,
    };
    const first = (await CallbackDeliverySession.begin(
      body,
      'fingerprint',
      new RedisCallbackLedger(redis),
    ))!;
    await expect(
      first.effect('chunk:0', async () => {
        throw new Error('response lost');
      }),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
    await first.release();
    await expect(
      CallbackDeliverySession.begin(body, 'fingerprint', new RedisCallbackLedger(redis)),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
  });
});
