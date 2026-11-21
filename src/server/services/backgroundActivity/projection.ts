import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
} from '@/database/schemas/agentRuntime';
import { agentWakeJobs as wakes } from '@/database/schemas/agentWake';
import type { ActivityStatus } from '@/types/backgroundActivity';

// Preserve PostgreSQL microseconds in cursors rather than rounding them through JS Date.
export const timestamp = (value: SQLWrapper) =>
  sql<string>`to_char(${value} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const metadata = (key: 'agentId' | 'topicId' | 'taskId' | 'threadId') =>
  sql<string>`coalesce(${checkpoints.state}->'metadata'->>${key}, ${checkpoints.metadata}->>${key})`;
// Keep correlated columns qualified when Drizzle renders a single-table selection.
const correlated = <T>(value: SQL) => sql<T>`${value}`;

export const checkpointStatus = correlated<ActivityStatus>(sql`case
  when ${checkpoints.state}->'interruption'->>'reason' = 'execution_outcome_unknown'
    or exists(select 1 from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId} and ${jobs.status} = 'unknown') then 'unknown'
  when ${checkpoints.state}->>'status' = 'waiting_for_human' then case when exists(
    select 1 from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId}
      and ${jobs.status} in ('queued','claimed','dispatched')
      and (${jobs.message}->'payload' ?| array['approvedToolCall','humanInput','rejectionReason'])
    ) then case when exists (
      select 1 from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId}
        and ${jobs.status} = 'queued' and (${jobs.message}->'payload' ?| array['approvedToolCall','humanInput','rejectionReason'])
      ) then 'queued' else 'running' end else 'waiting' end
  when ${checkpoints.state}->>'status' = 'running' and exists(
    select 1 from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId} and ${jobs.status} = 'queued'
    ) then 'queued'
  when ${checkpoints.state}->>'status' = 'running' then 'running'
  when ${checkpoints.state}->>'status' = 'done' then 'completed'
  when ${checkpoints.state}->>'status' = 'error' then 'failed'
  when ${checkpoints.state}->>'status' = 'interrupted' then 'cancelled'
  else 'queued' end`);
export const wakeStatus = correlated<ActivityStatus>(sql`case
  when ${wakes.status} in ('claimed','dispatched') then 'running'
  when ${wakes.status} = 'done' then 'completed'
  else ${wakes.status} end`);

// Version the incident, including child jobs, without sending execution state to the client.
export const agentIncidentToken = correlated<string>(sql`md5(jsonb_build_array(
  ${checkpoints.id}, ${timestamp(checkpoints.updatedAt)},
  (select jsonb_agg(jsonb_build_array(${jobs.id}, ${jobs.status}, ${jobs.attempts}, ${jobs.stepIndex}, ${jobs.errorCode}) order by ${jobs.id} collate "C")
    from ${jobs} where ${jobs.operationId} = ${checkpoints.id} and ${jobs.userId} = ${checkpoints.userId})
)::text)`);
export const wakeIncidentToken = correlated<string>(
  sql`md5(jsonb_build_array(${wakes.id}, ${timestamp(wakes.updatedAt)}, ${wakes.status}, ${wakes.attempts})::text)`,
);
