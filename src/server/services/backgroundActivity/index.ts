import { Buffer } from 'node:buffer';

import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';

import { agents } from '@/database/schemas/agent';
import { agentActivityReviews as reviews } from '@/database/schemas/agentActivity';
import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
} from '@/database/schemas/agentRuntime';
import { agentWakeJobs as wakes } from '@/database/schemas/agentWake';
import { tasks } from '@/database/schemas/task';
import { threads, topics } from '@/database/schemas/topic';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ActivityCategory,
  ActivityCursor,
  ActivityFilter,
  ActivityItem,
  ActivityKind,
  ActivityListInput,
  ActivityPage,
} from '@/types/backgroundActivity';

import {
  agentIncidentToken,
  checkpointStatus,
  metadata,
  timestamp,
  wakeIncidentToken,
  wakeStatus,
} from './projection';

const statusFilter = (status: SQL, filter: ActivityFilter) => {
  const groups = {
    active: ['queued', 'running'],
    waiting: ['waiting'],
    attention: ['unknown', 'failed'],
    finished: ['completed', 'cancelled'],
  };
  return filter === 'all' || filter === 'reviewed' ? undefined : inArray(status, groups[filter]);
};
const reviewFilter = (filter: ActivityFilter) =>
  filter === 'attention'
    ? isNull(reviews.id)
    : filter === 'reviewed'
      ? isNotNull(reviews.id)
      : undefined;
const reviewSelection = {
  decision: reviews.decision,
  evidence: reviews.evidence,
  reviewedAt: timestamp(reviews.createdAt),
};
const afterCursor = (
  category: ActivityCategory,
  date: SQLWrapper,
  id: SQLWrapper,
  cursor?: ActivityCursor,
) => {
  if (!cursor) return undefined;
  const point = sql`${cursor.createdAt}::timestamptz`;
  if (category !== cursor.category) return category === 'wake' ? lte(date, point) : lt(date, point);
  return or(lt(date, point), and(eq(date, point), sql`${id} collate "C" < ${cursor.id}`));
};
const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const text = (value: string | null | undefined) => value?.trim().slice(0, 200) || undefined;
const wakeKinds: Record<string, ActivityKind> = {
  'agent-signal': 'selfImprovement',
  'heartbeat': 'heartbeat',
  'schedule': 'schedule',
  'task-complete': 'taskUpdate',
  'thread-step': 'threadUpdate',
  'thread-complete': 'threadUpdate',
};

/** Read-only, account-scoped projections. Never loads messages, tool arguments or worker modules. */
export class BackgroundActivityService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {
    if (!userId) throw new Error('ACTIVITY_OWNER_REQUIRED');
  }
  async list(input: ActivityListInput = {}): Promise<ActivityPage> {
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 25)));
    const filter = input.filter ?? 'all';
    const [operations, wakeJobs] = await Promise.all([
      this.db
        .select({
          id: checkpoints.id,
          createdAt: timestamp(checkpoints.createdAt),
          updatedAt: timestamp(checkpoints.updatedAt),
          status: checkpointStatus,
          incidentToken: sql<
            string | null
          >`case when ${checkpointStatus} in ('unknown','failed') then ${agentIncidentToken} end`,
          review: reviewSelection,
          hasReviewHistory: sql<boolean>`exists(select 1 from ${reviews} where ${reviews.userId} = ${this.userId} and ${reviews.category} = 'agent' and ${reviews.activityId} = ${checkpoints.id})`,
          agentId: agents.id,
          agentTitle: agents.title,
          topicId: topics.id,
          threadId: threads.id,
          title: sql<string | null>`coalesce(${threads.title}, ${topics.title})`,
          taskId: tasks.id,
          taskTitle: tasks.name,
          stepCount: sql<unknown>`${checkpoints.state}->'stepCount'`,
          attempts: sql<unknown>`(select coalesce(sum(${jobs.attempts}),0) from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId})`,
          nextRunAt: timestamp(
            sql`(select min(${jobs.availableAt}) from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId} and ${jobs.status} = 'queued')`,
          ),
        })
        .from(checkpoints)
        .leftJoin(
          reviews,
          and(
            eq(reviews.userId, this.userId),
            eq(reviews.category, 'agent'),
            eq(reviews.activityId, checkpoints.id),
            eq(reviews.incidentToken, agentIncidentToken),
          ),
        )
        .leftJoin(
          threads,
          and(eq(threads.id, metadata('threadId')), eq(threads.userId, this.userId)),
        )
        .leftJoin(
          agents,
          and(
            sql`${agents.id} = coalesce(${metadata('agentId')}, ${threads.agentId})`,
            eq(agents.userId, this.userId),
          ),
        )
        .leftJoin(
          topics,
          and(
            sql`${topics.id} = coalesce(${metadata('topicId')}, ${threads.topicId})`,
            eq(topics.userId, this.userId),
          ),
        )
        .leftJoin(
          tasks,
          and(eq(tasks.id, metadata('taskId')), eq(tasks.createdByUserId, this.userId)),
        )
        .where(
          and(
            eq(checkpoints.userId, this.userId),
            statusFilter(checkpointStatus, filter),
            reviewFilter(filter),
            afterCursor('agent', checkpoints.createdAt, checkpoints.id, input.cursor),
          ),
        )
        .orderBy(desc(checkpoints.createdAt), sql`${checkpoints.id} collate "C" desc`)
        .limit(limit + 1),
      this.db
        .select({
          id: wakes.id,
          kind: wakes.kind,
          createdAt: timestamp(wakes.createdAt),
          updatedAt: timestamp(wakes.updatedAt),
          status: wakeStatus,
          hasReviewHistory: sql<boolean>`exists(select 1 from ${reviews} where ${reviews.userId} = ${this.userId} and ${reviews.category} = 'wake' and ${reviews.activityId} = ${wakes.id})`,
          incidentToken: sql<
            string | null
          >`case when ${wakeStatus} in ('unknown','failed') then ${wakeIncidentToken} end`,
          review: reviewSelection,
          attempts: wakes.attempts,
          agentId: agents.id,
          agentTitle: agents.title,
          taskId: tasks.id,
          taskTitle: tasks.name,
          topicId: topics.id,
          threadId: threads.id,
          title: sql<string | null>`coalesce(${threads.title}, ${topics.title})`,
          nextRunAt: timestamp(
            sql`case when ${wakes.status} = 'queued' then ${wakes.availableAt} end`,
          ),
        })
        .from(wakes)
        .leftJoin(
          reviews,
          and(
            eq(reviews.userId, this.userId),
            eq(reviews.category, 'wake'),
            eq(reviews.activityId, wakes.id),
            eq(reviews.incidentToken, wakeIncidentToken),
          ),
        )
        .leftJoin(
          threads,
          and(sql`${threads.id} = ${wakes.payload}->>'threadId'`, eq(threads.userId, this.userId)),
        )
        .leftJoin(
          tasks,
          and(
            sql`${tasks.id} = ${wakes.payload}->>'taskId'`,
            eq(tasks.createdByUserId, this.userId),
          ),
        )
        .leftJoin(
          agents,
          and(
            sql`${agents.id} = coalesce(${wakes.payload}->>'agentId', ${wakes.payload}->'sourceEvent'->'payload'->>'agentId', ${threads.agentId}, ${tasks.assigneeAgentId})`,
            eq(agents.userId, this.userId),
          ),
        )
        .leftJoin(
          topics,
          and(
            sql`${topics.id} = coalesce(${wakes.payload}->>'topicId', ${wakes.payload}->'sourceEvent'->'payload'->>'topicId', ${threads.topicId})`,
            eq(topics.userId, this.userId),
          ),
        )
        .where(
          and(
            eq(wakes.userId, this.userId),
            or(
              inArray(wakes.kind, ['heartbeat', 'schedule', 'agent-signal']),
              eq(wakes.status, 'unknown'),
            ),
            statusFilter(wakeStatus, filter),
            reviewFilter(filter),
            afterCursor('wake', wakes.createdAt, wakes.id, input.cursor),
          ),
        )
        .orderBy(desc(wakes.createdAt), sql`${wakes.id} collate "C" desc`)
        .limit(limit + 1),
    ]);
    const items: ActivityItem[] = [
      ...operations.map((row) => ({
        ...row,
        category: 'agent' as const,
        kind: 'conversation' as const,
        attempts: number(row.attempts),
        incidentToken: row.incidentToken ?? undefined,
        review: row.review?.decision ? row.review : undefined,
        stepCount: number(row.stepCount),
        agentId: row.agentId ?? undefined,
        agentTitle: text(row.agentTitle),
        topicId: row.topicId ?? undefined,
        threadId: row.threadId ?? undefined,
        title: text(row.title),
        taskId: row.taskId ?? undefined,
        taskTitle: text(row.taskTitle),
        nextRunAt: row.nextRunAt ?? undefined,
        canStop: ['queued', 'running', 'waiting'].includes(row.status),
      })),
      ...wakeJobs.map((row) => ({
        ...row,
        category: 'wake' as const,
        incidentToken: row.incidentToken ?? undefined,
        review: row.review?.decision ? row.review : undefined,
        kind: wakeKinds[row.kind] ?? 'event',
        agentId: row.agentId ?? undefined,
        agentTitle: text(row.agentTitle),
        topicId: row.topicId ?? undefined,
        threadId: row.threadId ?? undefined,
        title: text(row.title),
        taskId: row.taskId ?? undefined,
        taskTitle: text(row.taskTitle),
        nextRunAt: row.nextRunAt ?? undefined,
        canStop: false,
      })),
    ];
    items.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt > b.createdAt
          ? -1
          : 1
        : a.category !== b.category
          ? a.category === 'agent'
            ? -1
            : 1
          : Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
    );
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        items.length > limit && last
          ? { id: last.id, category: last.category, createdAt: last.createdAt }
          : undefined,
    };
  }
}
