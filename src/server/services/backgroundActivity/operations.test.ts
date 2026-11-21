// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  agentActivityReviews as reviews,
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
  agentWakeJobs as wakes,
  agentWorkerHeartbeats as beats,
  users,
} from '@/database/schemas';
import { WorkerHeartbeatStore } from '@/server/runtime/tasks/heartbeat';
import type { ActivityReviewInput } from '@/types/backgroundActivity';

import { BackgroundActivityService } from '.';
import { ActivityHealthService } from './health';
import { agentIncidentToken, checkpointStatus } from './projection';
import { ActivityReviewService } from './review';

const db = await getTestDB();
const owner = 'ops-owner',
  other = 'ops-other';
const activity = new BackgroundActivityService(db, owner);
const review = new ActivityReviewService(db, owner);
const health = new ActivityHealthService(db, owner);
beforeAll(async () => {
  await db.insert(users).values([{ id: owner }, { id: other }]);
});
beforeEach(async () => {
  await db.delete(reviews);
  await db.delete(checkpoints);
  await db.delete(wakes);
  await db.delete(beats);
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, other));
});
async function incident(userId = owner) {
  await db.insert(checkpoints).values({
    id: 'op',
    userId,
    metadata: {},
    state: {
      status: 'interrupted',
      stepCount: 2,
      interruption: { reason: 'execution_outcome_unknown', canResume: false },
    },
  });
  await db.insert(jobs).values({
    id: 'job',
    userId,
    operationId: 'op',
    stepIndex: 2,
    status: 'unknown',
    attempts: 1,
    message: { private: 'arguments' },
    intentHash: 'hash',
  });
}
const request = async (): Promise<ActivityReviewInput> => ({
  category: 'agent',
  id: 'op',
  incidentToken: (await activity.list()).items.find((i) => i.id === 'op')!.incidentToken!,
  decision: 'effect_confirmed',
  evidence: 'Checked the destination document and confirmed the saved result.',
});

it('uses the same incident version in joined lists and locked single-source queries', async () => {
  await incident();
  const query = db
    .select({ token: agentIncidentToken, status: checkpointStatus })
    .from(checkpoints);
  const [direct] = await query;
  const listed = (await activity.list()).items[0];
  expect(direct.token).toBe(listed.incidentToken);
});

it('records an idempotent review without changing, replaying or resuming the original execution', async () => {
  await incident();
  const input = await request();
  const before = await db.select().from(checkpoints);
  const beforeJobs = await db.select().from(jobs);
  const saved = await review.record(input);
  expect(await review.record(input)).toEqual(saved);
  expect(await db.select().from(reviews)).toHaveLength(1);
  expect(await db.select().from(checkpoints)).toEqual(before);
  expect(await db.select().from(jobs)).toEqual(beforeJobs);
  expect(await db.select().from(wakes)).toHaveLength(0);
  expect((await activity.list({ filter: 'attention' })).items).toHaveLength(0);
  expect((await activity.list({ filter: 'reviewed' })).items).toEqual([
    expect.objectContaining({ status: 'unknown', review: saved, canStop: false }),
  ]);
  expect(await new ActivityReviewService(db, owner).history('agent', 'op')).toEqual([saved]);
  await expect(review.record({ ...input, decision: 'no_effect' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

it('rejects stale evidence, foreign incidents and ineligible active runs', async () => {
  await incident(other);
  await expect(
    review.record({
      category: 'agent',
      id: 'op',
      incidentToken: '0'.repeat(32),
      decision: 'closed',
      evidence: 'Confirmed this is the wrong account.',
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await review.history('agent', 'op')).toEqual([]);
  await db.delete(checkpoints);
  await incident();
  const input = await request();
  await db.update(jobs).set({ attempts: 2 }).where(eq(jobs.id, 'job'));
  await expect(review.record(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(review.record({ ...(await request()), evidence: 'short' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  await db.update(checkpoints).set({ state: { status: 'running' } });
  await db.update(jobs).set({ status: 'queued' });
  await expect(review.record(await request())).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await db.select().from(reviews)).toHaveLength(0);
});

it('keeps the audit through notification updates and requires a new review for a new incident', async () => {
  await incident();
  await review.record(await request());
  await db.update(jobs).set({ notifiedAt: new Date() });
  expect((await activity.list({ filter: 'reviewed' })).items).toHaveLength(1);
  await db.update(jobs).set({ attempts: 2 });
  expect((await activity.list({ filter: 'attention' })).items).toHaveLength(1);
  expect((await activity.list({ filter: 'reviewed' })).items).toHaveLength(0);
  await review.record({
    ...(await request()),
    decision: 'closed',
    evidence: 'Checked again and ended follow-up without another execution.',
  });
  expect(await review.history('agent', 'op')).toHaveLength(2);
  await db.update(checkpoints).set({ state: { status: 'done' } });
  await db.update(jobs).set({ status: 'done' });
  expect((await activity.list()).items[0]).toMatchObject({
    status: 'completed',
    hasReviewHistory: true,
    incidentToken: undefined,
    review: undefined,
  });
});

it('serializes competing decisions so one incident has exactly one immutable conclusion', async () => {
  await incident();
  const input = await request();
  const outcomes = await Promise.allSettled([
    review.record(input),
    review.record({ ...input, decision: 'closed' }),
  ]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
    reason: { code: 'CONFLICT' },
  });
  expect(await db.select().from(reviews)).toHaveLength(1);
});

it('reviews wake exceptions with owner isolation while retaining quarantine and paused work', async () => {
  await db.insert(wakes).values({
    id: 'wake',
    userId: owner,
    kind: 'agent-signal',
    scopeKey: 'scope',
    payload: { secret: 'private' },
    status: 'unknown',
    intentHash: 'hash',
  });
  const row = (await activity.list()).items[0];
  const input: ActivityReviewInput = {
    category: 'wake',
    id: row.id,
    incidentToken: row.incidentToken!,
    decision: 'no_effect',
    evidence: 'Verified that no external result was written.',
  };
  await expect(new ActivityReviewService(db, other).record(input)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await review.record(input);
  expect((await activity.list({ filter: 'reviewed' })).items[0]).toMatchObject({
    status: 'unknown',
    review: { decision: 'no_effect' },
  });
  expect((await db.select().from(wakes))[0]).toMatchObject({
    status: 'unknown',
    attempts: 0,
    payload: { secret: 'private' },
  });
});

it('does not infer worker availability from an empty queue, and fences stopped incarnations', async () => {
  expect((await health.get()).workers.map((w) => w.status)).toEqual(['unobserved', 'unobserved']);
  const store = new WorkerHeartbeatStore(db);
  const old = await store.register('agent');
  await store.polling(old);
  expect((await health.get()).workers[0].status).toBe('busy');
  await store.success(old);
  await store.failure(old);
  await store.polling(old);
  expect((await health.get()).workers[0]).toMatchObject({
    status: 'degraded',
    consecutiveFailures: 1,
    lastSuccessAt: expect.any(String),
    lastFailureAt: expect.any(String),
  });
  await db.update(beats).set({ heartbeatAt: sql`clock_timestamp() - interval '21 seconds'` });
  expect((await health.get()).workers[0].status).toBe('unresponsive');
  const current = await store.register('agent');
  await store.stopped(old);
  await store.polling(old);
  await store.pulse(old);
  expect((await health.get()).workers[0]).toMatchObject({ status: 'online', healthyInstances: 1 });
  await store.stopping(current);
  await store.success(current);
  expect((await health.get()).workers[0].status).toBe('stopping');
  await store.stopped(current);
  expect((await health.get()).workers[0].status).toBe('stopped');
});

it('reports only this account queue delay, future work, quarantine and expired leases', async () => {
  await incident();
  const values = { kind: 'schedule', scopeKey: 'scope', intentHash: 'hash', payload: {} };
  await db.insert(wakes).values([
    {
      ...values,
      id: 'ready',
      userId: owner,
      availableAt: sql`clock_timestamp() - interval '120 seconds'`,
    },
    {
      ...values,
      id: 'future',
      userId: owner,
      availableAt: sql`clock_timestamp() + interval '1 hour'`,
    },
    {
      ...values,
      id: 'expired',
      userId: owner,
      status: 'dispatched',
      leaseUntil: sql`clock_timestamp() - interval '1 second'`,
    },
    {
      ...values,
      id: 'foreign',
      userId: other,
      availableAt: sql`clock_timestamp() - interval '1 day'`,
    },
    { ...values, id: 'global', userId: null },
  ]);
  expect((await health.get()).queue).toEqual({
    ready: 1,
    scheduled: 1,
    running: 1,
    expiredLeases: 1,
    quarantined: 1,
    oldestReadyAgeSeconds: 120,
  });
  expect(JSON.stringify(await health.get())).not.toMatch(/foreign|secret|scope|payload|ops-other/);
});
