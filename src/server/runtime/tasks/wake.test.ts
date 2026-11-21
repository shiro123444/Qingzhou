// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { AgentRuntime } from '@lobechat/agent-runtime';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import {
  agentRuntimeCheckpoints,
  agentRuntimeJobs,
  agentWakeJobs,
  messages,
  tasks,
  taskTopics,
  threads,
  topics,
  users,
} from '@/database/schemas';
import * as database from '@/database/server';
import { TaskService } from '@/server/services/task';
import { TaskLifecycleService } from '@/server/services/taskLifecycle';

import { NativeAgentStore } from './store';
import { createNativeWakeExecutor } from './wakeExecution';
import { collectNativeCallbackIntents, NATIVE_THREAD_CALLBACK } from './wakeHooks';
import { enqueueNativeHeartbeat, scanNativeTasks, taskWakeVersion } from './wakeScheduling';
import { NativeWakeStore, wakeHash } from './wakeStore';
import { NativeWakeWorker } from './wakeWorker';

const db = await getTestDB();
const alice = `wake-${randomUUID()}`,
  bob = `wake-${randomUUID()}`;
const store = new NativeWakeStore(db);
const guard = { assertHeld: () => {}, signal: new AbortController().signal };
beforeAll(async () => {
  await db.insert(users).values([{ id: alice }, { id: bob }]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.delete(agentRuntimeCheckpoints);
  await db.delete(agentWakeJobs);
  await db.delete(tasks).where(eq(tasks.createdByUserId, alice));
  await db.delete(topics).where(eq(topics.userId, alice));
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, alice));
  await db.delete(users).where(eq(users.id, bob));
});
async function task(overrides: Record<string, any> = {}) {
  const [row] = await db
    .insert(tasks)
    .values({
      id: `task_${randomUUID()}`,
      identifier: randomUUID(),
      seq: 1,
      createdByUserId: alice,
      instruction: 'test',
      status: 'scheduled',
      automationMode: 'heartbeat',
      heartbeatInterval: 10,
      lastHeartbeatAt: new Date(Date.now() - 20_000),
      ...overrides,
    })
    .returning();
  return row;
}
const expire = () =>
  db.update(agentWakeJobs).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` });

it('persists one heartbeat per occurrence, refuses foreign owners and survives store recreation', async () => {
  const row = await task();
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  expect(await enqueueNativeHeartbeat(db, row.id, alice)).toBe(id);
  await expect(enqueueNativeHeartbeat(db, row.id, bob)).rejects.toThrow('unavailable');
  expect((await new NativeWakeStore(db).claim())?.id).toBe(id);
  await expire();
  await store.recover();
  expect((await store.claim())?.id).toBe(id);
});
it('serializes a scope across workers while allowing an independent scope', async () => {
  const base = { kind: 'agent-signal' as const, userId: alice, payload: {}, scopeKey: 'same' };
  await store.enqueue({ ...base, key: 'a' });
  await store.enqueue({ ...base, key: 'b' });
  const a = await store.claim();
  expect(a).not.toBeNull();
  expect(await new NativeWakeStore(db).claim()).toBeNull();
  await store.enqueue({ ...base, userId: bob, key: 'foreign-scope' });
  expect((await store.claim())?.userId).toBe(bob);
  await store.enqueue({ ...base, key: 'c', scopeKey: 'other' });
  expect((await store.claim())?.scopeKey).toBe(wakeHash([alice, 'other']));
});
it('quarantines an uncertain wake without replay and pauses the affected task', async () => {
  const row = await task();
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  const claimed = (await store.claim())!;
  await store.dispatch({ id, owner: claimed.leaseOwner! });
  await expire();
  const execute = vi.fn();
  await new NativeWakeWorker(new NativeWakeStore(db), execute).tick();
  expect(execute).not.toHaveBeenCalled();
  expect((await db.select().from(agentWakeJobs))[0].status).toBe('unknown');
  expect((await db.select().from(tasks).where(eq(tasks.id, row.id)))[0].status).toBe('paused');
});
it('retains a structured provider failure without replay or logging its response body', async () => {
  await store.enqueue({
    kind: 'agent-signal',
    userId: alice,
    key: 'provider-failure',
    scopeKey: 'provider-failure',
    payload: {},
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const execute = vi.fn().mockRejectedValue({
    errorType: 'PermissionDenied',
    error: { message: 'private-provider-response-canary' },
    stack: { unexpected: true },
  });
  const worker = new NativeWakeWorker(store, execute);
  expect(await worker.tick()).toBe(1);
  expect((await db.select().from(agentWakeJobs))[0].status).toBe('unknown');
  expect(await worker.tick()).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-provider-response-canary');
});
it('reconciles an already prepared agent operation instead of recreating it after a crash', async () => {
  const row = await task();
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  const claimed = (await store.claim())!;
  await store.dispatch({ id, owner: claimed.leaseOwner! });
  const agents = new NativeAgentStore(db);
  await agents.create('prepared', { userId: alice });
  await agents.save(
    'prepared',
    AgentRuntime.createInitialState({
      operationId: 'prepared',
      metadata: { userId: alice, nativeWakeId: id, taskId: row.id },
      status: 'idle',
    }),
  );
  await expire();
  await store.recover();
  const recovered = (await store.claim())!;
  expect(recovered.payload.resumeOperationId).toBe('prepared');
});
it('refuses a stale wake admission in the same transaction as state and first-step enqueue', async () => {
  const row = await task({ status: 'running' });
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  const claimed = (await store.claim())!;
  await store.dispatch({ id, owner: claimed.leaseOwner! });
  const agents = new NativeAgentStore(db);
  await agents.create('admission', { userId: alice });
  const initial = AgentRuntime.createInitialState({
    operationId: 'admission',
    metadata: { userId: alice, taskId: row.id },
    status: 'idle',
  });
  await agents.save('admission', initial);
  await db.update(tasks).set({ status: 'paused' }).where(eq(tasks.id, row.id));
  const running = {
    ...initial,
    status: 'running',
    metadata: {
      ...initial.metadata,
      _nativeAdmissionLease: { id, owner: claimed.leaseOwner! },
      _pendingNextStep: { operationId: 'admission', stepIndex: 0, endpoint: 'unused', delay: 0 },
    },
  };
  await expect(agents.save('admission', running)).rejects.toThrow('TASK_CHANGED');
  expect((await agents.checkpoint('admission'))?.state?.status).toBe('idle');
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(0);
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, row.id));
  await agents.save('admission', running);
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(1);
  expect(
    (await agents.checkpoint('admission'))?.state?.metadata._nativeAdmissionLease,
  ).toBeUndefined();
});
it('repeats a scanner safely after restart without duplicating the same Cron occurrence', async () => {
  const now = new Date('2026-11-10T08:01:00Z');
  const row = await task({
    automationMode: 'schedule',
    schedulePattern: '0 8 * * *',
    scheduleTimezone: 'UTC',
    lastHeartbeatAt: null,
    createdAt: new Date('2026-11-09T00:00:00Z'),
  });
  const job = { payload: { after: '2026-11-10T07:59:00Z', until: now.toISOString() } } as any;
  await scanNativeTasks(db, job, guard);
  await scanNativeTasks(db, job, guard);
  const jobs = await db.select().from(agentWakeJobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload.version).toBe(taskWakeVersion(row));
  expect(jobs[0].payload.slot).toBe('2026-11-10T08:00:00.000Z');
});
it('atomically persists a native completion command with its canonical checkpoint', async () => {
  const row = await task({ status: 'running' });
  const agents = new NativeAgentStore(db);
  await agents.create('callback', { userId: alice });
  const initial = AgentRuntime.createInitialState({
    operationId: 'callback',
    metadata: { userId: alice, taskId: row.id },
    status: 'running',
  });
  await agents.save('callback', initial);
  const lease = (await agents.acquireStep('callback', 0))!;
  const command = {
    kind: 'task-complete' as const,
    userId: alice,
    key: 'callback:complete',
    scopeKey: `task:${row.id}`,
    payload: { operationId: 'callback', taskId: row.id },
  };
  const state = {
    ...initial,
    status: 'done',
    stepCount: 1,
    metadata: { ...initial.metadata, _pendingNativeCallbacks: [command] },
  };
  expect(
    await agents.save('callback', state, lease, {
      newState: state as any,
      stepIndex: 0,
      executionTime: 1,
    }),
  ).toBe(true);
  expect((await db.select().from(agentWakeJobs))[0].kind).toBe('task-complete');
});

async function completion(withContent = false) {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  const factory = await import('@/server/modules/AgentRuntime/factory');
  const { InMemoryStreamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  vi.spyOn(factory, 'createStreamEventManager').mockReturnValue(new InMemoryStreamEventManager());
  vi.spyOn(database, 'getServerDB').mockResolvedValue(db);
  const row = await task({
    status: 'running',
    config: { brief: { mode: withContent ? 'auto' : 'agent' } },
  });
  const [topic] = await db
    .insert(topics)
    .values({ userId: alice, title: 'native task' })
    .returning();
  await db
    .insert(taskTopics)
    .values({ taskId: row.id, topicId: topic.id, userId: alice, seq: 1, operationId: 'loop' });
  const agents = new NativeAgentStore(db);
  await agents.create('loop', { userId: alice });
  await agents.save(
    'loop',
    AgentRuntime.createInitialState({
      operationId: 'loop',
      metadata: {
        userId: alice,
        taskId: row.id,
        topicId: topic.id,
        nativeTaskVersion: taskWakeVersion(row),
      },
      status: 'done',
    }),
  );
  await store.enqueue({
    kind: 'task-complete',
    userId: alice,
    key: 'loop:complete',
    scopeKey: `task:${row.id}`,
    payload: {
      operationId: 'loop',
      taskId: row.id,
      version: taskWakeVersion(row),
      topicId: topic.id,
      reason: 'done',
      ...(withContent ? { lastAssistantContent: 'Completed task' } : {}),
    },
  });
  return row;
}
it('uses the real completion service to persist the next heartbeat without QStash or HTTP', async () => {
  const row = await completion();
  expect(await new NativeWakeWorker(store, createNativeWakeExecutor(db)).tick()).toBe(1);
  const [current] = await db.select().from(tasks).where(eq(tasks.id, row.id));
  const jobs = await db.select().from(agentWakeJobs);
  expect(current.status).toBe('scheduled');
  expect(jobs.find((job) => job.kind === 'task-complete')?.status).toBe('done');
  const next = jobs.find((job) => job.kind === 'heartbeat')!;
  expect(next.status).toBe('queued');
  expect(next.availableAt.getTime()).toBeGreaterThan(Date.now());
  expect((current.context as any).scheduler.tickMessageId).toBe(next.id);
});
it('does not re-arm when the user pauses while a completion is being processed', async () => {
  const row = await completion(true);
  // Controlled paid-work boundaries; status, control-generation and queue writes use real SQL.
  vi.spyOn(TaskLifecycleService.prototype as any, 'generateHandoff').mockResolvedValue(undefined);
  const synthesize = vi
    .spyOn(TaskLifecycleService.prototype as any, 'synthesizeTopicBrief')
    .mockImplementation(async () => {
      await new TaskService(db, alice).updateStatus({ id: row.id, status: 'paused' });
    });
  await new NativeWakeWorker(store, createNativeWakeExecutor(db)).tick();
  expect(synthesize).toHaveBeenCalledOnce();
  expect((await db.select().from(tasks).where(eq(tasks.id, row.id)))[0].status).toBe('paused');
  expect(
    (await db.select().from(agentWakeJobs)).find((job) => job.kind === 'task-complete')?.status,
  ).toBe('cancelled');
  expect((await db.select().from(agentWakeJobs)).some((job) => job.kind === 'heartbeat')).toBe(
    false,
  );
});

it('starts the already prepared operation after restart with its original input and no duplicate topic', async () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  const factory = await import('@/server/modules/AgentRuntime/factory');
  const { InMemoryStreamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  vi.spyOn(factory, 'createStreamEventManager').mockReturnValue(new InMemoryStreamEventManager());
  const row = await task({ status: 'running' });
  const [topic] = await db.insert(topics).values({ userId: alice }).returning();
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  const claimed = (await store.claim())!;
  await store.dispatch({ id, owner: claimed.leaseOwner! });
  const agents = new NativeAgentStore(db);
  await agents.create('prepared-run', { userId: alice });
  await agents.save(
    'prepared-run',
    AgentRuntime.createInitialState({
      operationId: 'prepared-run',
      status: 'idle',
      metadata: {
        userId: alice,
        nativeWakeId: id,
        taskId: row.id,
        topicId: topic.id,
        _nativeInitialContext: {
          phase: 'user_input',
          payload: { message: [{ content: 'original task input' }] },
        },
      },
    }),
  );
  await expire();
  await new NativeWakeWorker(new NativeWakeStore(db), createNativeWakeExecutor(db)).tick();
  const [agentJob] = await db.select().from(agentRuntimeJobs);
  expect(agentJob.operationId).toBe('prepared-run');
  expect(agentJob.message.context.payload.message[0].content).toBe('original task input');
  expect(await db.select().from(taskTopics).where(eq(taskTopics.taskId, row.id))).toHaveLength(1);
  expect((await db.select().from(tasks).where(eq(tasks.id, row.id)))[0].totalTopics).toBe(1);
});
it('keeps user controls authoritative over a retired worker and starts a new occurrence identity', async () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  const factory = await import('@/server/modules/AgentRuntime/factory');
  const { InMemoryStreamEventManager } =
    await import('@/server/modules/AgentRuntime/InMemoryStreamEventManager');
  vi.spyOn(factory, 'createStreamEventManager').mockReturnValue(new InMemoryStreamEventManager());
  const row = await task({ status: 'running' });
  const id = await enqueueNativeHeartbeat(db, row.id, alice);
  const claimed = (await store.claim())!;
  const lease = { id, owner: claimed.leaseOwner! };
  await store.dispatch(lease);
  const service = new TaskService(db, alice);
  await service.updateStatus({ id: row.id, status: 'paused' });
  await store.fail(lease, true);
  expect((await db.select().from(tasks).where(eq(tasks.id, row.id)))[0].status).toBe('paused');
  await service.updateStatus({ id: row.id, status: 'scheduled' });
  expect(await enqueueNativeHeartbeat(db, row.id, alice)).not.toBe(id);
  expect((await db.select().from(agentWakeJobs).where(eq(agentWakeJobs.id, id)))[0].status).toBe(
    'cancelled',
  );
});
it('deduplicates repeated AgentSignal requests while retaining meaningful payload conflicts', async () => {
  const input = {
    kind: 'agent-signal' as const,
    userId: alice,
    key: 'event',
    scopeKey: `signal:${alice}`,
    payload: {
      userId: alice,
      sourceEvent: {
        sourceId: 'event',
        timestamp: 1,
        payload: { requestedAt: 'one', message: 'original' },
      },
    },
  };
  const id = await store.enqueue(input);
  expect(
    await store.enqueue({
      ...input,
      payload: {
        ...input.payload,
        sourceEvent: {
          ...input.payload.sourceEvent,
          timestamp: 2,
          payload: { requestedAt: 'two', message: 'original' },
        },
      },
    }),
  ).toBe(id);
  await expect(
    store.enqueue({
      ...input,
      payload: {
        ...input.payload,
        sourceEvent: { ...input.payload.sourceEvent, payload: { message: 'changed' } },
      },
    }),
  ).rejects.toThrow('PAYLOAD_CONFLICT');
});

it('persists and delivers a native sub-agent completion without an in-memory callback', async () => {
  const [topic] = await db.insert(topics).values({ userId: alice }).returning();
  const threadId = `thread_${randomUUID()}`,
    sourceId = `msg_${randomUUID()}`;
  await db
    .insert(messages)
    .values({ id: sourceId, userId: alice, topicId: topic.id, role: 'tool', content: 'pending' });
  await db.insert(threads).values({
    id: threadId,
    userId: alice,
    topicId: topic.id,
    type: 'isolation',
    status: 'processing',
  });
  const metadata = { userId: alice, topicId: topic.id, threadId, sourceMessageId: sourceId };
  const agents = new NativeAgentStore(db);
  await agents.create('child', { userId: alice });
  await agents.save(
    'child',
    AgentRuntime.createInitialState({ operationId: 'child', metadata, status: 'running' }),
  );
  const lease = (await agents.acquireStep('child', 0))!;
  const finished = AgentRuntime.createInitialState({
    operationId: 'child',
    metadata,
    status: 'done',
    stepCount: 1,
    messages: [{ role: 'assistant', content: 'background result' }],
  });
  const commands = collectNativeCallbackIntents(
    'child',
    'onComplete',
    { finalState: finished } as any,
    [
      {
        id: 'thread',
        type: 'onComplete',
        webhook: {
          url: NATIVE_THREAD_CALLBACK,
          delivery: 'native',
          body: { threadId, sourceMessageId: sourceId, startedAt: new Date().toISOString() },
        },
      },
    ],
  );
  finished.metadata!._pendingNativeCallbacks = commands;
  await agents.save('child', finished, lease, {
    newState: finished,
    executionTime: 1,
    stepIndex: 0,
  });
  await new NativeWakeWorker(store, createNativeWakeExecutor(db)).tick();
  expect((await db.select().from(threads).where(eq(threads.id, threadId)))[0].status).toBe(
    'completed',
  );
  expect((await db.select().from(messages).where(eq(messages.id, sourceId)))[0].content).toBe(
    'background result',
  );
});
