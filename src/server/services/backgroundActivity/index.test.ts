// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
  agents,
  agentWakeJobs as wakes,
  tasks,
  threads,
  topics,
  users,
} from '@/database/schemas';
import type { ActivityCursor } from '@/types/backgroundActivity';

import { BackgroundActivityService } from '.';

const db = await getTestDB();
const owner = 'activity-owner',
  foreign = 'activity-other';
const service = new BackgroundActivityService(db, owner);
beforeAll(async () => {
  await db.insert(users).values([{ id: owner }, { id: foreign }]);
  await db.insert(agents).values([
    { id: 'agent', userId: owner, title: 'My assistant' },
    { id: 'foreign-agent', userId: foreign, title: 'Private assistant' },
  ]);
  await db.insert(topics).values([
    { id: 'topic', userId: owner, agentId: 'agent', title: 'My conversation' },
    { id: 'foreign-topic', userId: foreign, title: 'Private topic' },
  ]);
  await db.insert(threads).values([
    {
      id: 'thread',
      userId: owner,
      agentId: 'agent',
      topicId: 'topic',
      type: 'standalone',
      title: 'Subtask',
    },
    {
      id: 'foreign-thread',
      userId: foreign,
      agentId: 'foreign-agent',
      topicId: 'foreign-topic',
      type: 'standalone',
      title: 'Private subtask',
    },
  ]);
  await db.insert(tasks).values([
    {
      id: 'task',
      identifier: 'T-1',
      seq: 1,
      createdByUserId: owner,
      instruction: 'secret instructions',
      name: 'My task',
      assigneeAgentId: 'agent',
    },
    {
      id: 'foreign-task',
      identifier: 'T-1',
      seq: 1,
      createdByUserId: foreign,
      instruction: 'private',
      name: 'Private task',
    },
  ]);
});
beforeEach(async () => {
  await db.delete(checkpoints);
  await db.delete(wakes);
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, foreign));
});

const operation = (
  id: string,
  status = 'running',
  metadata: Record<string, string> = {},
  userId = owner,
) =>
  db.insert(checkpoints).values({
    id,
    userId,
    metadata,
    state: {
      status,
      stepCount: 3,
      metadata,
      messages: ['sensitive content'],
      error: 'secret provider error',
    },
    history: [{ private: 'history' }],
  });
const job = (operationId: string, overrides: Partial<typeof jobs.$inferInsert> = {}) =>
  db.insert(jobs).values({
    id: `job-${operationId}`,
    operationId,
    userId: owner,
    stepIndex: 0,
    intentHash: 'hash',
    message: {},
    ...overrides,
  });
const wake = (id: string, overrides: Partial<typeof wakes.$inferInsert> = {}) =>
  db.insert(wakes).values({
    id,
    userId: owner,
    kind: 'schedule',
    scopeKey: 'scope',
    payload: {},
    intentHash: 'hash',
    ...overrides,
  });

it('projects only owned titles and links without exposing state, payloads, errors or global scanners', async () => {
  await operation('own', 'running', { agentId: 'agent', topicId: 'topic', taskId: 'task' });
  await operation('untrusted-links', 'error', {
    agentId: 'foreign-agent',
    topicId: 'foreign-topic',
    taskId: 'foreign-task',
    threadId: 'foreign-thread',
  });
  await operation('foreign', 'running', {}, foreign);
  await wake('global', { userId: null });
  await wake('foreign-wake', { userId: foreign });
  await wake('own-wake', {
    payload: {
      taskId: 'task',
      sourceEvent: { payload: { topicId: 'topic' } },
      apiKey: 'sensitive payload',
    },
    receipt: { private: true },
    errorCode: 'private error',
  });
  await wake('untrusted-wake', {
    payload: {
      agentId: 'foreign-agent',
      topicId: 'foreign-topic',
      taskId: 'foreign-task',
      threadId: 'foreign-thread',
    },
  });
  const { items } = await service.list();
  expect(items).toHaveLength(4);
  expect(items.find((i) => i.id === 'own')).toMatchObject({
    agentId: 'agent',
    topicId: 'topic',
    taskId: 'task',
    title: 'My conversation',
    taskTitle: 'My task',
    stepCount: 3,
    canStop: true,
  });
  expect(items.find((i) => i.id === 'own-wake')).toMatchObject({
    agentId: 'agent',
    topicId: 'topic',
    taskId: 'task',
    canStop: false,
  });
  for (const id of ['untrusted-links', 'untrusted-wake']) {
    expect(items.find((i) => i.id === id)).toMatchObject({
      agentId: undefined,
      topicId: undefined,
      taskId: undefined,
      agentTitle: undefined,
      title: undefined,
      taskTitle: undefined,
      threadId: undefined,
    });
  }
  expect(JSON.stringify(items)).not.toMatch(
    /sensitive|secret|private|foreign-|history|apiKey|messages|receipt/,
  );
  expect(() => new BackgroundActivityService(db, '')).toThrow('ACTIVITY_OWNER_REQUIRED');
});

it('resolves owned nested AgentSignal sources and thread callback context without returning payloads', async () => {
  await wake('signal', {
    kind: 'agent-signal',
    payload: { sourceEvent: { payload: { agentId: 'agent', topicId: 'topic' } } },
  });
  await wake('thread-callback', {
    kind: 'thread-complete',
    status: 'unknown',
    payload: { threadId: 'thread' },
  });
  await operation('subtask', 'waiting_for_human', { threadId: 'thread' });
  const { items } = await service.list();
  expect(items.find((i) => i.id === 'signal')).toMatchObject({
    agentId: 'agent',
    topicId: 'topic',
  });
  for (const id of ['thread-callback', 'subtask'])
    expect(items.find((i) => i.id === id)).toMatchObject({
      threadId: 'thread',
      agentId: 'agent',
      topicId: 'topic',
      title: 'Subtask',
    });
});

it('reports queued chat work and changes accepted approval to running once claimed', async () => {
  await operation('queued');
  await job('queued');
  await operation('accepted-running', 'waiting_for_human');
  await job('accepted-running', {
    status: 'claimed',
    message: { payload: { humanInput: { text: 'yes' } } },
  });
  const { items } = await service.list({ filter: 'active' });
  expect(items.find((i) => i.id === 'queued')?.status).toBe('queued');
  expect(items.find((i) => i.id === 'accepted-running')?.status).toBe('running');
});

it('distinguishes pending approval from an accepted resume and quarantined execution', async () => {
  await operation('approval', 'waiting_for_human');
  await operation('accepted', 'waiting_for_human');
  await job('accepted', {
    message: { payload: { approvedToolCall: { id: 'tool' } } },
    attempts: 2,
  });
  await operation('uncertain', 'interrupted');
  await job('uncertain', { status: 'unknown', attempts: 1 });
  await operation('failed', 'error');
  await operation('complete', 'done');
  await operation('stopped', 'interrupted');
  expect((await service.list({ filter: 'waiting' })).items.map((i) => i.id)).toEqual(['approval']);
  expect((await service.list({ filter: 'active' })).items).toEqual([
    expect.objectContaining({
      id: 'accepted',
      status: 'queued',
      attempts: 2,
      canStop: true,
      nextRunAt: expect.any(String),
    }),
  ]);
  expect((await service.list({ filter: 'attention' })).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'uncertain', status: 'unknown', canStop: false }),
      expect.objectContaining({ id: 'failed', status: 'failed', canStop: false }),
    ]),
  );
  expect((await service.list({ filter: 'finished' })).items.map((i) => i.status).sort()).toEqual([
    'cancelled',
    'completed',
  ]);
});

it('shows wake attempts, future availability and callback exceptions without successful callback noise', async () => {
  await wake('heartbeat', {
    kind: 'heartbeat',
    attempts: 2,
    availableAt: new Date('2030-01-01T08:00:00Z'),
  });
  await wake('reflection', { kind: 'agent-signal', status: 'done' });
  await wake('callback-success', { kind: 'thread-complete', status: 'done' });
  await wake('callback-unknown', { kind: 'thread-complete', status: 'unknown' });
  await wake('claimed', { status: 'claimed' });
  const { items } = await service.list();
  expect(items.map((i) => i.id)).not.toContain('callback-success');
  expect(items.find((i) => i.id === 'heartbeat')).toMatchObject({
    kind: 'heartbeat',
    attempts: 2,
    nextRunAt: '2030-01-01T08:00:00.000000Z',
    status: 'queued',
  });
  expect(items.find((i) => i.id === 'reflection')).toMatchObject({
    kind: 'selfImprovement',
    status: 'completed',
    nextRunAt: undefined,
  });
  expect((await service.list({ filter: 'attention' })).items).toEqual([
    expect.objectContaining({ id: 'callback-unknown', kind: 'threadUpdate', status: 'unknown' }),
  ]);
  expect(items.find((i) => i.id === 'claimed')?.status).toBe('running');
});

it('paginates both sources at microsecond precision with stable same-time binary id ordering', async () => {
  for (const id of ['A', 'a', 'z', 'new', 'old']) await operation(id, 'done');
  for (const id of ['Z', 'a', 'z']) await wake(id);
  await db.update(checkpoints).set({ createdAt: sql`'2026-11-13T00:00:00.123456Z'::timestamptz` });
  await db.update(wakes).set({ createdAt: sql`'2026-11-13T00:00:00.123456Z'::timestamptz` });
  await db
    .update(checkpoints)
    .set({ createdAt: sql`'2026-11-13T00:00:00.123457Z'::timestamptz` })
    .where(eq(checkpoints.id, 'new'));
  await db
    .update(checkpoints)
    .set({ createdAt: sql`'2026-11-13T00:00:00.123455Z'::timestamptz` })
    .where(eq(checkpoints.id, 'old'));
  const ids: string[] = [];
  let cursor: ActivityCursor | undefined;
  do {
    const page = await service.list({ limit: 2, cursor });
    ids.push(...page.items.map((i) => `${i.category}:${i.id}`));
    cursor = page.nextCursor;
  } while (cursor && ids.length < 12);
  expect(ids).toEqual([
    'agent:new',
    'agent:z',
    'agent:a',
    'agent:A',
    'wake:z',
    'wake:a',
    'wake:Z',
    'agent:old',
  ]);
  expect(cursor).toBeUndefined();
});
