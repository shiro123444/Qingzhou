import { and, desc, eq, sql } from 'drizzle-orm';

import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
  topics,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

/** Observe a scoped harness run without importing the computer provider or starting a job. */
export async function readBotActivity(db: LobeChatDatabase, ownerId: string, agentId: string) {
  const [botActivity] = await db
    .select({
      topicId: topics.id,
      phase: sql<
        'working' | 'approval' | 'queued'
      >`case when ${checkpoints.metadata}->>'status' = 'waiting_for_human' then 'approval' when ${checkpoints.leaseUntil} > clock_timestamp() then 'working' else 'queued' end`,
    })
    .from(checkpoints)
    .innerJoin(
      topics,
      and(eq(topics.userId, ownerId), sql`${topics.id} = ${checkpoints.metadata}->>'topicId'`),
    )
    .where(
      and(
        eq(checkpoints.userId, ownerId),
        sql`${checkpoints.metadata}->>'agentId' = ${agentId}`,
        sql`${checkpoints.metadata}->>'status' in ('running', 'waiting_for_human')`,
        sql`(${checkpoints.metadata}->>'status' = 'waiting_for_human' or ${checkpoints.leaseUntil} > clock_timestamp() or exists(select 1 from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${ownerId} and ${jobs.status} = 'queued'))`,
      ),
    )
    .orderBy(desc(checkpoints.updatedAt))
    .limit(1);
  return botActivity ?? null;
}
