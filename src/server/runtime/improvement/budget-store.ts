import {
  harnessDigest,
  type LearningBudgetRef,
  type LearningScope,
  type LearningUsage,
} from '@lobechat/agent-runtime';
import type { LobeChatDatabase } from '@lobechat/database';
import { and, eq, sql } from 'drizzle-orm';

import { assertAccountActive } from '../learning-lifecycle/files';

import { learningBudgetRoots } from '@/database/schemas';

import {
  addLearningUsage,
  assertLearningUsage,
  exceedsLearningUsage,
  type LearningAttempt,
  learningBudgetError as fail,
  type LearningBudgetPort,
  type LearningBudgetState,
} from './budget';

const key = (scope: LearningScope, rootId: string) =>
  and(eq(learningBudgetRoots.userId, scope.userId), eq(learningBudgetRoots.rootId, rootId));
function identity(scope: LearningScope, id: string) {
  const subject = scope.subject;
  if (
    ['__proto__', 'constructor', 'prototype'].includes(id) ||
    !scope.userId?.trim() ||
    !id?.trim() ||
    id.length > 512 ||
    !subject ||
    (subject.kind === 'agent'
      ? !subject.agentId?.trim()
      : subject.kind === 'presentation'
        ? !subject.jobId?.trim() || !subject.sessionId?.trim()
        : true)
  )
    throw fail('LEARNING_BUDGET_INVALID');
}
export class DatabaseLearningBudget implements LearningBudgetPort {
  constructor(private db: LobeChatDatabase) {}
  async open(scope: LearningScope, rootId: string, limit: LearningUsage) {
    identity(scope, rootId);
    assertAccountActive(scope.userId);
    assertLearningUsage(limit);
    const state: LearningBudgetState = {
      scope,
      rootId,
      limit,
      cancelled: false,
      exhausted: false,
      children: {},
      attempts: {},
    };
    await this.db
      .insert(learningBudgetRoots)
      .values({ userId: scope.userId, rootId, state: state as unknown as Record<string, unknown> })
      .onConflictDoNothing();
    const existing = await this.read(scope, rootId);
    if ((await harnessDigest(existing.limit)) !== (await harnessDigest(limit)))
      throw fail('LEARNING_BUDGET_CONFLICT');
  }
  async read(scope: LearningScope, rootId: string) {
    identity(scope, rootId);
    assertAccountActive(scope.userId);
    const [row] = await this.db.select().from(learningBudgetRoots).where(key(scope, rootId));
    if (!row) throw fail('LEARNING_BUDGET_NOT_FOUND');
    assertAccountActive(scope.userId);
    const state = row.state as unknown as LearningBudgetState;
    if (
      (await harnessDigest(state.scope)) !== (await harnessDigest(scope)) ||
      state.rootId !== rootId
    )
      throw fail('LEARNING_BUDGET_SCOPE');
    return state;
  }
  private async mutate(
    scope: LearningScope,
    rootId: string,
    run: (state: LearningBudgetState) => void | Promise<void>,
  ) {
    identity(scope, rootId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      const [row] = await tx
        .select()
        .from(learningBudgetRoots)
        .where(key(scope, rootId))
        .for('update');
      if (!row) throw fail('LEARNING_BUDGET_NOT_FOUND');
      const state = row.state as unknown as LearningBudgetState;
      if ((await harnessDigest(state.scope)) !== (await harnessDigest(scope)))
        throw fail('LEARNING_BUDGET_SCOPE');
      await run(state);
      await tx
        .update(learningBudgetRoots)
        .set({ state: state as unknown as Record<string, unknown> })
        .where(key(scope, rootId));
    });
  }
  allocate(ref: LearningBudgetRef, limit: LearningUsage) {
    assertLearningUsage(limit);
    identity(ref.scope, ref.childId);
    assertAccountActive(ref.scope.userId);
    return this.mutate(ref.scope, ref.rootId, async (state) => {
      if (state.cancelled || state.exhausted) throw fail('LEARNING_BUDGET_CANCELLED');
      const existing = state.children[ref.childId];
      if (existing) {
        if ((await harnessDigest(existing.limit)) !== (await harnessDigest(limit)))
          throw fail('LEARNING_BUDGET_CONFLICT');
        return;
      }
      const allocated = Object.values(state.children).reduce(
        (sum, c) => addLearningUsage(sum, c.limit),
        limit,
      );
      if (exceedsLearningUsage(allocated, state.limit)) throw fail('LEARNING_BUDGET_EXCEEDED');
      if (Object.keys(state.children).length >= 64) throw fail('LEARNING_BUDGET_QUOTA');
      state.children[ref.childId] = { limit };
    });
  }
  reserve(ref: LearningBudgetRef, requestId: string, requestHash: string, usage: LearningUsage) {
    identity(ref.scope, requestId);
    assertAccountActive(ref.scope.userId);
    assertLearningUsage(usage);
    if (usage.calls !== 1 || !requestHash.trim()) throw fail('LEARNING_BUDGET_INVALID');
    return this.mutate(ref.scope, ref.rootId, (state) => {
      if (state.cancelled) throw fail('LEARNING_BUDGET_CANCELLED');
      if (state.exhausted) throw fail('LEARNING_BUDGET_EXCEEDED');
      const id = JSON.stringify([ref.childId, requestId]);
      if (state.attempts[id])
        throw fail(
          state.attempts[id].requestHash === requestHash
            ? 'LEARNING_ATTEMPT_EXISTS'
            : 'LEARNING_BUDGET_CONFLICT',
        );
      const child = state.children[ref.childId];
      if (!child) throw fail('LEARNING_BUDGET_NOT_ALLOCATED');
      const used = Object.values(state.attempts)
        .filter((a) => a.childId === ref.childId)
        .reduce(
          (sum, a) =>
            addLearningUsage(sum, {
              calls: 1,
              tokens: Math.max(a.reserved.tokens, a.measured?.tokens ?? 0),
              costMicros: Math.max(a.reserved.costMicros, a.measured?.costMicros ?? 0),
            }),
          usage,
        );
      if (exceedsLearningUsage(used, child.limit)) throw fail('LEARNING_BUDGET_EXCEEDED');
      if (Object.keys(state.attempts).length >= 256) throw fail('LEARNING_BUDGET_QUOTA');
      state.attempts[id] = {
        childId: ref.childId,
        requestHash,
        reserved: usage,
        state: 'reserved',
      };
    });
  }
  settle(
    ref: LearningBudgetRef,
    id: string,
    status: 'completed' | 'unknown',
    measured?: LearningAttempt['measured'],
  ) {
    if (measured && Object.values(measured).some((n) => !Number.isSafeInteger(n) || n! < 0))
      throw fail('LEARNING_BUDGET_INVALID');
    return this.mutate(ref.scope, ref.rootId, (state) => {
      const attempt = state.attempts[JSON.stringify([ref.childId, id])];
      if (!attempt) throw fail('LEARNING_ATTEMPT_MISSING');
      if (attempt.state !== 'reserved') return; // Replayed/late callbacks cannot rewrite a settled receipt.
      attempt.state = status;
      if (measured) attempt.measured = measured;
      if (
        (measured?.tokens ?? 0) > attempt.reserved.tokens ||
        (measured?.costMicros ?? 0) > attempt.reserved.costMicros
      )
        state.exhausted = true;
    });
  }
  cancel(scope: LearningScope, rootId: string) {
    return this.mutate(scope, rootId, (state) => {
      state.cancelled = true;
    });
  }
}
