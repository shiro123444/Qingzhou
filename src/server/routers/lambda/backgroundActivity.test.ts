// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { BackgroundActivityService } from '@/server/services/backgroundActivity';
import { ActivityHealthService } from '@/server/services/backgroundActivity/health';
import { ActivityReviewService } from '@/server/services/backgroundActivity/review';

import { backgroundActivityRouter } from './backgroundActivity';

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));
const callerFactory = createCallerFactory(backgroundActivityRouter);
beforeEach(() => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('requires authentication and prevents a client from selecting a different owner', async () => {
  const list = vi
    .spyOn(BackgroundActivityService.prototype, 'list')
    .mockResolvedValue({ items: [] });
  const anonymous = callerFactory(await createContextInner());
  await expect(anonymous.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  const caller = callerFactory(await createContextInner({ userId: 'owner' }));
  await expect(caller.list({ userId: 'other' } as never)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  expect(list).not.toHaveBeenCalled();
  await expect(caller.list()).resolves.toEqual({ items: [] });
  expect(list).toHaveBeenCalledWith({ filter: 'all', limit: 25 });
});

it('rejects invalid filters, unbounded pages and malformed cursors before querying records', async () => {
  const list = vi
    .spyOn(BackgroundActivityService.prototype, 'list')
    .mockResolvedValue({ items: [] });
  const caller = callerFactory(await createContextInner({ userId: 'owner' }));
  for (const input of [
    { limit: 51 },
    { limit: 0 },
    { filter: 'invalid' },
    { cursor: { id: 'x', category: 'agent', createdAt: '2026-11-13T00:00:00Z' } },
    { cursor: { id: 'x', category: 'agent', createdAt: 'bad' } },
  ]) {
    await expect(caller.list(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
  expect(list).not.toHaveBeenCalled();
  await caller.list({
    cursor: { id: 'x', category: 'wake', createdAt: '2026-11-13T00:00:00.123456Z' },
  });
  expect(list).toHaveBeenCalledOnce();
});

it('does not query native records when the deployment uses another runtime', async () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'local');
  const list = vi
    .spyOn(BackgroundActivityService.prototype, 'list')
    .mockResolvedValue({ items: [] });
  const caller = callerFactory(await createContextInner({ userId: 'owner' }));
  await expect(caller.list()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(list).not.toHaveBeenCalled();
});

it('authenticates monitoring and review endpoints and rejects client-supplied ownership or execution commands', async () => {
  const get = vi.spyOn(ActivityHealthService.prototype, 'get').mockResolvedValue({
    checkedAt: '',
    workers: [],
    queue: {
      ready: 0,
      scheduled: 0,
      running: 0,
      expiredLeases: 0,
      quarantined: 0,
      oldestReadyAgeSeconds: 0,
    },
  });
  const record = vi
    .spyOn(ActivityReviewService.prototype, 'record')
    .mockResolvedValue({ decision: 'closed', evidence: 'Checked the result.', reviewedAt: '' });
  const history = vi.spyOn(ActivityReviewService.prototype, 'history').mockResolvedValue([]);
  const input = {
    category: 'agent' as const,
    id: 'op',
    incidentToken: 'a'.repeat(32),
    decision: 'closed' as const,
    evidence: 'Checked the result.',
  };
  const anonymous = callerFactory(await createContextInner());
  await expect(anonymous.health()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(anonymous.recordReview(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(anonymous.reviewHistory({ category: 'agent', id: 'op' })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  const caller = callerFactory(await createContextInner({ userId: 'owner' }));
  for (const bad of [
    { ...input, userId: 'other' },
    { ...input, replay: true },
    { ...input, decision: 'retry' },
    { ...input, evidence: 'short' },
    { ...input, incidentToken: 'bad' },
  ]) {
    await expect(caller.recordReview(bad as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  }
  expect(record).not.toHaveBeenCalled();
  await caller.recordReview(input);
  await caller.health();
  await caller.reviewHistory({ category: 'agent', id: 'op' });
  expect(record).toHaveBeenCalledWith(input);
  expect(history).toHaveBeenCalledWith('agent', 'op');
  expect(get).toHaveBeenCalledOnce();
  vi.stubEnv('AGENT_RUNTIME_MODE', 'local');
  await expect(caller.health()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await expect(caller.recordReview(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(record).toHaveBeenCalledOnce();
});
