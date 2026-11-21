import { and, asc, eq, gt, inArray } from 'drizzle-orm';

import type { AgentWakeJob } from '@/database/schemas/agentWake';
import { tasks } from '@/database/schemas/task';
import type { LobeChatDatabase } from '@/database/type';

import { latestCronSlot } from './cron';
import { taskWakeAnchor, taskWakeVersion, wakeHash } from './wakeIdentity';
import { NativeWakeStore } from './wakeStore';
import type { WakeResult } from './wakeWorker';
import type { NativeExecutionGuard } from './worker';

export { taskWakeAnchor, taskWakeVersion } from './wakeIdentity';

export async function enqueueNativeHeartbeat(
  db: LobeChatDatabase,
  taskId: string,
  userId: string,
  delay?: number,
  expectedVersion?: string,
) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.createdByUserId, userId)));
  if (
    !task ||
    task.automationMode !== 'heartbeat' ||
    !task.heartbeatInterval ||
    task.heartbeatInterval <= 0
  )
    throw new Error('Heartbeat task unavailable');
  const version = taskWakeVersion(task),
    anchor = taskWakeAnchor(task);
  if (expectedVersion && version !== expectedVersion) throw new Error('NATIVE_WAKE_TASK_CHANGED');
  return new NativeWakeStore(db).enqueue({
    kind: 'heartbeat',
    userId,
    key: wakeHash([taskId, version, anchor]),
    scopeKey: `task:${taskId}`,
    payload: { taskId, version, anchor, allowPaused: task.status === 'paused' },
    availableAt:
      delay === undefined
        ? new Date(new Date(anchor).getTime() + task.heartbeatInterval * 1_000)
        : new Date(Date.now() + delay * 1_000),
  });
}

/** Paged persistent scanner. Coalesces missed Cron slots to the latest within 24 hours. */
export async function scanNativeTasks(
  db: LobeChatDatabase,
  job: AgentWakeJob,
  guard: NativeExecutionGuard,
): Promise<WakeResult> {
  const store = new NativeWakeStore(db);
  const until = new Date(job.payload.until ?? Date.now());
  const after = new Date(job.payload.after ?? until.getTime() - 60_000);
  const page = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.automationMode, ['heartbeat', 'schedule']),
        job.payload.cursor ? gt(tasks.id, job.payload.cursor) : undefined,
      ),
    )
    .orderBy(asc(tasks.id))
    .limit(100);
  for (const task of page) {
    guard.assertHeld();
    if (!['scheduled', 'backlog'].includes(task.status)) continue;
    const version = taskWakeVersion(task);
    try {
      if (
        task.automationMode === 'heartbeat' &&
        task.heartbeatInterval &&
        task.heartbeatInterval > 0
      ) {
        await enqueueNativeHeartbeat(db, task.id, task.createdByUserId);
      } else if (task.automationMode === 'schedule' && task.schedulePattern) {
        const lower = new Date(
          Math.max(
            after.getTime(),
            task.createdAt.getTime() - 1,
            task.lastHeartbeatAt?.getTime() ?? 0,
          ),
        );
        const slot = latestCronSlot(task.schedulePattern, task.scheduleTimezone, lower, until);
        if (slot)
          await store.enqueue({
            kind: 'schedule',
            userId: task.createdByUserId,
            key: wakeHash([task.id, version, slot.toISOString()]),
            scopeKey: `task:${task.id}`,
            payload: { taskId: task.id, version, slot: slot.toISOString() },
          });
      }
    } catch (error) {
      // Storage outages retry the scan; only invalid schedule syntax pauses that task.
      if (!(error instanceof Error) || !/cron|time zone/i.test(error.message)) throw error;
      guard.assertHeld();
      await db
        .update(tasks)
        .set({ status: 'paused', error: 'Invalid schedule or timezone' })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.createdByUserId, task.createdByUserId),
            eq(tasks.updatedAt, task.updatedAt),
          ),
        );
    }
  }
  return {
    recurring:
      page.length === 100
        ? {
            payload: {
              after: after.toISOString(),
              until: until.toISOString(),
              cursor: page.at(-1)!.id,
            },
            delay: 0,
          }
        : { payload: { after: until.toISOString() }, delay: 15_000 },
  };
}
