// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { AgentRuntime, type AgentState } from '@lobechat/agent-runtime';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import {
  agentRuntimeCheckpoints,
  agentRuntimeJobs,
  botDeliveryJobs,
  users,
} from '@/database/schemas';
import { PostgresAgentStateManager } from '@/server/modules/AgentRuntime/PostgresAgentStateManager';
import type { QueueMessage } from '@/server/services/queue/types';

import { NativeAgentStore } from './store';
import { NativeAgentWorker } from './worker';

const db = await getTestDB();
const alice = `native-${randomUUID()}`;
const bob = `native-${randomUUID()}`;
const store = new NativeAgentStore(db);
const manager = new PostgresAgentStateManager(db);
beforeAll(async () => {
  await db.insert(users).values([{ id: alice }, { id: bob }]);
});
afterEach(async () => {
  await db.delete(agentRuntimeCheckpoints);
  await db.delete(botDeliveryJobs);
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, alice));
  await db.delete(users).where(eq(users.id, bob));
});

const state = (stepCount = 0, status: AgentState['status'] = 'running') =>
  AgentRuntime.createInitialState({
    operationId: 'op',
    metadata: { userId: alice },
    status,
    stepCount,
  });
const message = (stepIndex = 0): QueueMessage => ({
  endpoint: 'http://app.test/api/agent/run',
  operationId: 'op',
  stepIndex,
  delay: 0,
});
async function setup(status: AgentState['status'] = 'running') {
  await manager.createOperationMetadata('op', { userId: alice });
  await manager.saveAgentState('op', state(0, status));
}
const expireJob = () =>
  db.update(agentRuntimeJobs).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });

it('retains an approval checkpoint beyond the cache TTL and across manager recreation', async () => {
  await setup('waiting_for_human');
  await db
    .update(agentRuntimeCheckpoints)
    .set({ updatedAt: sql`clock_timestamp() - interval '7 days'` });
  const restarted = new PostgresAgentStateManager(db);
  expect((await restarted.loadAgentState('op'))?.status).toBe('waiting_for_human');
  expect((await restarted.getOperationMetadata('op'))?.userId).toBe(alice);
  expect(await restarted.cleanupExpiredOperations()).toBe(0);
});

it('deduplicates an accepted step, rejects changed inputs, and enforces its owner', async () => {
  await setup();
  const first = await store.enqueue(alice, message());
  expect(await store.enqueue(alice, { ...message(), delay: 123 })).toBe(first);
  await expect(
    store.enqueue(alice, { ...message(), payload: { approvedToolCall: { id: 'other' } } }),
  ).rejects.toThrow('PAYLOAD_CONFLICT');
  await expect(store.enqueue(bob, message())).rejects.toThrow('CHECKPOINT_MISSING');
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(1);
});

it('does not let repeated creation reset an accepted operation configuration', async () => {
  await setup('waiting_for_human');
  await expect(
    manager.createOperationMetadata('op', {
      userId: alice,
      agentConfig: { systemRole: 'changed' },
    }),
  ).rejects.toThrow('OPERATION_EXISTS');
  await expect(manager.createOperationMetadata('op', { userId: bob })).rejects.toThrow(
    'OWNER_MISMATCH',
  );
  expect((await manager.loadAgentState('op'))?.status).toBe('waiting_for_human');
  expect((await manager.getOperationMetadata('op'))?.userId).toBe(alice);
});

it('fences expired step owners and does not let a late commit insert a continuation', async () => {
  await setup();
  const old = (await manager.acquireStepLease('op', 0))!;
  await db
    .update(agentRuntimeCheckpoints)
    .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });
  const current = (await new PostgresAgentStateManager(db).acquireStepLease('op', 0))!;
  const next = state(1);
  next.metadata!._pendingNextStep = message(1);
  expect(await manager.saveAgentStateWithLease('op', next, old)).toBe(false);
  expect(await manager.releaseStepLease(old)).toBe(false);
  expect(await manager.renewStepLease(old)).toBe(false);
  expect((await manager.loadAgentState('op'))?.stepCount).toBe(0);
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(0);
  expect(await manager.releaseStepLease(current)).toBe(true);
});

it('commits the step, its next task and bot outbox in one transaction', async () => {
  await setup();
  const lease = (await manager.acquireStepLease('op', 0))!;
  const next = state(1);
  next.metadata!._pendingNextStep = message(1);
  next.metadata!._pendingBotCallbacks = [
    {
      applicationId: 'app',
      operationId: 'op',
      platformThreadId: 'wechat:sender',
      userId: alice,
      type: 'step',
      stepIndex: 0,
    },
  ];
  expect(
    await manager.saveStepResultWithLease(
      'op',
      { executionTime: 1, newState: next, stepIndex: 0 },
      lease,
    ),
  ).toBe(true);
  expect((await manager.loadAgentState('op'))?.stepCount).toBe(1);
  expect((await db.select().from(agentRuntimeJobs))[0].stepIndex).toBe(1);
  expect(await db.select().from(botDeliveryJobs)).toHaveLength(1);
  await manager.releaseStepLease(lease);
});

it('rolls back state and queued work together if a callback has a different owner', async () => {
  await setup();
  const lease = (await manager.acquireStepLease('op', 0))!;
  const next = state(1);
  next.metadata!._pendingNextStep = message(1);
  next.metadata!._pendingBotCallbacks = [
    {
      applicationId: 'app',
      operationId: 'op',
      platformThreadId: 'wechat:sender',
      userId: bob,
      type: 'step',
      stepIndex: 0,
    },
  ];
  await expect(
    manager.saveStepResultWithLease(
      'op',
      { executionTime: 1, newState: next, stepIndex: 0 },
      lease,
    ),
  ).rejects.toMatchObject({ cause: { message: 'NATIVE_CALLBACK_OWNER_MISMATCH' } });
  expect((await manager.loadAgentState('op'))?.stepCount).toBe(0);
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(0);
  await manager.releaseStepLease(lease);
});

it('commits error callbacks even when the executor uses the error-state commit path', async () => {
  await setup();
  const lease = (await manager.acquireStepLease('op', 0))!;
  const failed = state(0, 'error');
  failed.metadata!._pendingBotCallbacks = [
    {
      applicationId: 'app',
      operationId: 'op',
      platformThreadId: 'wechat:sender',
      userId: alice,
      type: 'completion',
      stepIndex: 0,
    },
  ];
  expect(await manager.saveAgentStateWithLease('op', failed, lease)).toBe(true);
  expect((await manager.loadAgentState('op'))?.status).toBe('error');
  expect(await db.select().from(botDeliveryJobs)).toHaveLength(1);
  await manager.releaseStepLease(lease);
});

it('keeps undispatched work recoverable after repeated pre-dispatch crashes', async () => {
  await setup();
  await store.enqueue(alice, message());
  await store.claim();
  await db
    .update(agentRuntimeJobs)
    .set({ attempts: 8, leaseUntil: sql`clock_timestamp() - interval '1 second'` });
  await store.recover();
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('queued');
  expect((await manager.loadAgentState('op'))?.status).toBe('running');
});

it('reclaims a pre-dispatch claim after restart and executes it only once', async () => {
  await setup();
  await store.enqueue(alice, message());
  const old = (await store.claim())!;
  await expireJob();
  const restartedStore = new NativeAgentStore(db);
  const execute = vi.fn(async () => {
    const lease = (await manager.acquireStepLease('op', 0))!;
    await manager.saveStepResultWithLease(
      'op',
      { executionTime: 1, newState: state(1, 'done'), stepIndex: 0 },
      lease,
    );
    await manager.releaseStepLease(lease);
    return { success: true, nextStepScheduled: false, state: {} };
  });
  const worker = new NativeAgentWorker(restartedStore, execute);
  expect(await worker.tick()).toBe(1);
  expect(await worker.tick()).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await store.renewJob({ id: old.id, owner: old.leaseOwner! })).toBe(false);
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('done');
});

it('quarantines an uncommitted dispatch after crash instead of repeating an external action', async () => {
  await setup();
  await store.enqueue(alice, message());
  const claimed = (await store.claim())!;
  const lease = { id: claimed.id, owner: claimed.leaseOwner! };
  await store.dispatch(lease);
  await expireJob();
  const execute = vi.fn();
  await new NativeAgentWorker(new NativeAgentStore(db), execute).tick();
  expect(execute).not.toHaveBeenCalled();
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('unknown');
  expect((await manager.loadAgentState('op'))?.status).toBe('interrupted');
  expect(await store.finish(lease, 'done')).toBe(false);
});

it('recovers a committed step without replaying it and retains its durable continuation', async () => {
  await setup();
  await store.enqueue(alice, message());
  const claimed = (await store.claim())!;
  await store.dispatch({ id: claimed.id, owner: claimed.leaseOwner! });
  const lease = (await manager.acquireStepLease('op', 0))!;
  const next = state(1);
  next.metadata!._pendingNextStep = { ...message(1), delay: 60_000 };
  await manager.saveStepResultWithLease(
    'op',
    { executionTime: 1, newState: next, stepIndex: 0 },
    lease,
  );
  await manager.releaseStepLease(lease);
  await expireJob();
  const execute = vi.fn();
  await new NativeAgentWorker(new NativeAgentStore(db), execute).tick();
  expect(execute).not.toHaveBeenCalled();
  const rows = await db.select().from(agentRuntimeJobs).orderBy(agentRuntimeJobs.stepIndex);
  expect(rows.map((row) => row.status)).toEqual(['done', 'queued']);
});

it('cancels queued work and invalidates in-flight ownership without reverting newer state', async () => {
  await setup();
  await store.enqueue(alice, message());
  const lease = (await manager.acquireStepLease('op', 0))!;
  await manager.saveAgentState('op', { ...state(), status: 'interrupted' });
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('cancelled');
  expect(await manager.renewStepLease(lease)).toBe(false);
  expect(await manager.saveAgentStateWithLease('op', state(1), lease)).toBe(false);
});

it('retains interruption notifications until the event bus confirms publication', async () => {
  await setup();
  await store.enqueue(alice, message());
  const job = (await store.claim())!;
  await store.dispatch({ id: job.id, owner: job.leaseOwner! });
  await expireJob();
  const notify = vi
    .fn()
    .mockRejectedValueOnce(new Error('event bus offline'))
    .mockResolvedValue(undefined);
  const worker = new NativeAgentWorker(new NativeAgentStore(db), vi.fn(), {
    notifySettled: notify,
  });
  await expect(worker.tick()).rejects.toThrow('event bus offline');
  expect(await store.pendingNotifications()).toHaveLength(1);
  await worker.tick();
  expect(await store.pendingNotifications()).toHaveLength(0);
  await worker.tick();
  expect(notify).toHaveBeenCalledTimes(2);
});

it('recovers a committed terminal notification without executing its step again', async () => {
  await setup();
  await store.enqueue(alice, message());
  const job = (await store.claim())!;
  await store.dispatch({ id: job.id, owner: job.leaseOwner! });
  const lease = (await manager.acquireStepLease('op', 0))!;
  await manager.saveStepResultWithLease(
    'op',
    { executionTime: 1, newState: state(1, 'done'), stepIndex: 0 },
    lease,
  );
  await manager.releaseStepLease(lease);
  await expireJob();
  const notify = vi
    .fn()
    .mockRejectedValueOnce(new Error('event bus offline'))
    .mockResolvedValue(undefined);
  const execute = vi.fn();
  const worker = new NativeAgentWorker(new NativeAgentStore(db), execute, {
    notifySettled: notify,
  });
  await expect(worker.tick()).rejects.toThrow('event bus offline');
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('done');
  expect(await store.pendingNotifications()).toHaveLength(1);
  await worker.tick();
  expect(await store.pendingNotifications()).toHaveLength(0);
  expect(execute).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(2);
});

it('does not dispatch a queued job when a required execution service is unavailable', async () => {
  await setup();
  await store.enqueue(alice, message());
  const execute = vi.fn();
  const worker = new NativeAgentWorker(store, execute, {
    beforeTick: async () => {
      throw new Error('offline');
    },
  });
  await expect(worker.tick()).rejects.toThrow('offline');
  expect(execute).not.toHaveBeenCalled();
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('queued');
});

it('stops an in-flight worker without admitting another job or replaying its unknown outcome', async () => {
  await setup();
  await store.enqueue(alice, message());
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const execute = vi.fn(async (_job, guard) => {
    entered();
    await new Promise<void>((_resolve, reject) =>
      guard.signal.addEventListener('abort', () => reject(guard.signal.reason), { once: true }),
    );
    return { success: true, state: {}, nextStepScheduled: false };
  });
  const worker = new NativeAgentWorker(store, execute);
  const stop = worker.start(10_000);
  await started;
  await stop();
  expect(await worker.tick()).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await db.select().from(agentRuntimeJobs))[0].status).toBe('unknown');
});
