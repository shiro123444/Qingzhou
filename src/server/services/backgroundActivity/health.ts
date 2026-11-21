import { eq, sql, type SQLWrapper } from 'drizzle-orm';

import { agentWorkerHeartbeats as beats } from '@/database/schemas/agentActivity';
import { agentRuntimeJobs as jobs } from '@/database/schemas/agentRuntime';
import { agentWakeJobs as wakes } from '@/database/schemas/agentWake';
import type { LobeChatDatabase } from '@/database/type';
import type {
  ActivityHealth,
  QueueHealth,
  WorkerHealth,
  WorkerPhase,
} from '@/types/backgroundActivity';

import { timestamp } from './projection';

const fresh = sql`${beats.heartbeatAt} >= clock_timestamp() - interval '20 seconds'`;
const count = (condition: SQLWrapper) =>
  sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
const queueSelection = (table: {
  status: SQLWrapper;
  availableAt: SQLWrapper;
  leaseUntil: SQLWrapper;
}) => ({
  ready: count(sql`${table.status} = 'queued' and ${table.availableAt} <= clock_timestamp()`),
  scheduled: count(sql`${table.status} = 'queued' and ${table.availableAt} > clock_timestamp()`),
  running: count(sql`${table.status} in ('claimed','dispatched')`),
  expiredLeases: count(
    sql`${table.status} in ('claimed','dispatched') and (${table.leaseUntil} is null or ${table.leaseUntil} <= clock_timestamp())`,
  ),
  quarantined: count(sql`${table.status} = 'unknown'`),
  oldestReadyAgeSeconds:
    sql<number>`coalesce(max(greatest(0, extract(epoch from clock_timestamp() - ${table.availableAt}))) filter (where ${table.status} = 'queued' and ${table.availableAt} <= clock_timestamp()), 0)`.mapWith(
      Number,
    ),
  checkedAt: timestamp(sql`clock_timestamp()`),
});

/** Only deployment-level liveness aggregates are shared; job metrics are owner-scoped. */
export class ActivityHealthService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {
    if (!userId) throw new Error('ACTIVITY_OWNER_REQUIRED');
  }
  async get(): Promise<ActivityHealth> {
    const [workers, [agentQueue], [wakeQueue]] = await Promise.all([
      this.db
        .select({
          kind: beats.kind,
          healthy: count(sql`${fresh} and ${beats.phase} in ('idle','busy')`),
          busy: count(sql`${fresh} and ${beats.phase} = 'busy'`),
          degraded: count(sql`${fresh} and ${beats.phase} = 'degraded'`),
          stopping: count(sql`${fresh} and ${beats.phase} = 'stopping'`),
          latestPhase: sql<WorkerPhase>`(array_agg(${beats.phase} order by ${beats.heartbeatAt} desc, ${beats.startedAt} desc))[1]`,
          heartbeatAt: timestamp(sql`max(${beats.heartbeatAt})`),
          lastPollAt: timestamp(sql`max(${beats.lastPollAt})`),
          lastSuccessAt: timestamp(sql`max(${beats.lastSuccessAt})`),
          lastFailureAt: timestamp(sql`max(${beats.lastFailureAt})`),
          consecutiveFailures:
            sql<number>`coalesce(max(${beats.consecutiveFailures}) filter (where ${fresh} and ${beats.phase} = 'degraded'), 0)`.mapWith(
              Number,
            ),
        })
        .from(beats)
        .groupBy(beats.kind),
      this.db.select(queueSelection(jobs)).from(jobs).where(eq(jobs.userId, this.userId)),
      this.db.select(queueSelection(wakes)).from(wakes).where(eq(wakes.userId, this.userId)),
    ]);
    const queue: QueueHealth = {
      ready: agentQueue.ready + wakeQueue.ready,
      scheduled: agentQueue.scheduled + wakeQueue.scheduled,
      running: agentQueue.running + wakeQueue.running,
      expiredLeases: agentQueue.expiredLeases + wakeQueue.expiredLeases,
      quarantined: agentQueue.quarantined + wakeQueue.quarantined,
      oldestReadyAgeSeconds: Math.floor(
        Math.max(agentQueue.oldestReadyAgeSeconds, wakeQueue.oldestReadyAgeSeconds),
      ),
    };
    return {
      checkedAt: agentQueue.checkedAt,
      queue,
      workers: (['agent', 'wake'] as const).map((kind) => {
        const row = workers.find((row) => row.kind === kind);
        if (!row)
          return {
            kind,
            status: 'unobserved',
            healthyInstances: 0,
            degradedInstances: 0,
            consecutiveFailures: 0,
          };
        const status: WorkerHealth['status'] = row.healthy
          ? row.busy
            ? 'busy'
            : 'online'
          : row.degraded
            ? 'degraded'
            : row.stopping
              ? 'stopping'
              : row.latestPhase === 'stopped'
                ? 'stopped'
                : 'unresponsive';
        return {
          kind,
          status,
          healthyInstances: row.healthy,
          degradedInstances: row.degraded,
          consecutiveFailures: row.consecutiveFailures,
          heartbeatAt: row.heartbeatAt ?? undefined,
          lastPollAt: row.lastPollAt ?? undefined,
          lastSuccessAt: row.lastSuccessAt ?? undefined,
          lastFailureAt: row.lastFailureAt ?? undefined,
        };
      }),
    };
  }
}
