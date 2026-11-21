import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, desc, eq, sql } from 'drizzle-orm';

import { agentActivityReviews as reviews } from '@/database/schemas/agentActivity';
import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
} from '@/database/schemas/agentRuntime';
import { agentWakeJobs as wakes } from '@/database/schemas/agentWake';
import type { LobeChatDatabase } from '@/database/type';
import {
  type ActivityCategory,
  type ActivityReview,
  type ActivityReviewInput,
  REVIEW_DECISIONS,
} from '@/types/backgroundActivity';

import {
  agentIncidentToken,
  checkpointStatus,
  timestamp,
  wakeIncidentToken,
  wakeStatus,
} from './projection';

/** Human evidence is an annotation, not an execution receipt or a replay authorization. */
export class ActivityReviewService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {
    if (!userId) throw new Error('ACTIVITY_OWNER_REQUIRED');
  }
  async history(category: ActivityCategory, id: string): Promise<ActivityReview[]> {
    return this.db
      .select({
        decision: reviews.decision,
        evidence: reviews.evidence,
        reviewedAt: timestamp(reviews.createdAt),
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.userId, this.userId),
          eq(reviews.category, category),
          eq(reviews.activityId, id),
        ),
      )
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(20);
  }
  async record(input: ActivityReviewInput): Promise<ActivityReview> {
    const evidence = input.evidence.trim();
    if (
      !REVIEW_DECISIONS.includes(input.decision) ||
      [...evidence].length < 10 ||
      evidence.length > 2000
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A review requires a decision and evidence',
      });
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      let incident;
      if (input.category === 'agent') {
        const [held] = await tx
          .select({ id: checkpoints.id })
          .from(checkpoints)
          .where(and(eq(checkpoints.id, input.id), eq(checkpoints.userId, this.userId)))
          .for('update');
        if (!held) throw new TRPCError({ code: 'NOT_FOUND' });
        // Match the runtime's checkpoint-before-job lock order.
        await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.operationId, input.id), eq(jobs.userId, this.userId)))
          .for('update');
        [incident] = await tx
          .select({ token: agentIncidentToken, status: checkpointStatus })
          .from(checkpoints)
          .where(eq(checkpoints.id, held.id));
      } else {
        const [held] = await tx
          .select({ id: wakes.id })
          .from(wakes)
          .where(and(eq(wakes.id, input.id), eq(wakes.userId, this.userId)))
          .for('update');
        if (!held) throw new TRPCError({ code: 'NOT_FOUND' });
        [incident] = await tx
          .select({ token: wakeIncidentToken, status: wakeStatus })
          .from(wakes)
          .where(eq(wakes.id, held.id));
      }
      if (
        !incident ||
        incident.token !== input.incidentToken ||
        !['unknown', 'failed'].includes(incident.status)
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Activity changed; refresh before reviewing',
        });
      const where = and(
        eq(reviews.userId, this.userId),
        eq(reviews.category, input.category),
        eq(reviews.activityId, input.id),
        eq(reviews.incidentToken, input.incidentToken),
      );
      const [existing] = await tx
        .select({
          decision: reviews.decision,
          evidence: reviews.evidence,
          reviewedAt: timestamp(reviews.createdAt),
        })
        .from(reviews)
        .where(where);
      if (existing) {
        if (existing.decision !== input.decision || existing.evidence !== evidence)
          throw new TRPCError({ code: 'CONFLICT', message: 'This incident already has a review' });
        return existing;
      }
      const [saved] = await tx
        .insert(reviews)
        .values({
          id: randomUUID(),
          userId: this.userId,
          category: input.category,
          activityId: input.id,
          incidentToken: input.incidentToken,
          decision: input.decision,
          evidence,
        })
        .returning({
          decision: reviews.decision,
          evidence: reviews.evidence,
          reviewedAt: timestamp(reviews.createdAt),
        });
      return saved;
    });
  }
}
