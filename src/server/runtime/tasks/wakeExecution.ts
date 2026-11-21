import { and, eq, sql } from 'drizzle-orm';

import { agentRuntimeJobs } from '@/database/schemas/agentRuntime';
import type { AgentWakeJob } from '@/database/schemas/agentWake';
import { messages } from '@/database/schemas/message';
import { tasks, taskTopics } from '@/database/schemas/task';
import { threads } from '@/database/schemas/topic';
import type { LobeChatDatabase } from '@/database/type';

import { NativeAgentStore } from './store';
import { scanNativeTasks, taskWakeAnchor, taskWakeVersion } from './wakeScheduling';
import { NativeWakeStore } from './wakeStore';
import type { WakeResult } from './wakeWorker';
import type { NativeExecutionGuard } from './worker';

async function resumePreparedTask(
  db: LobeChatDatabase,
  job: AgentWakeJob,
  guard: NativeExecutionGuard,
) {
  const checkpoint = await new NativeAgentStore(db).checkpoint(job.payload.resumeOperationId);
  const state = checkpoint?.state,
    taskId = job.payload.taskId;
  if (
    !state ||
    checkpoint?.userId !== job.userId ||
    state.metadata?.nativeWakeId !== job.id ||
    state.metadata?.taskId !== taskId
  )
    throw new Error('Prepared task scope mismatch');
  if (['done', 'error', 'interrupted'].includes(state.status))
    return { receipt: { operationId: checkpoint!.id, alreadySettled: true } };
  guard.assertHeld();
  await new NativeWakeStore(db).effect({ id: job.id, owner: job.leaseOwner! }, async (tx) => {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.createdByUserId, job.userId!)))
      .for('update');
    if (!task || task.status !== 'running' || taskWakeVersion(task) !== job.payload.version)
      throw new Error('Prepared task was changed or paused');
    const [link] = await tx
      .insert(taskTopics)
      .values({
        taskId,
        topicId: state.metadata.topicId,
        userId: job.userId!,
        operationId: checkpoint!.id,
        seq: (task.totalTopics ?? 0) + 1,
      })
      .onConflictDoNothing()
      .returning({ id: taskTopics.id });
    await tx
      .update(tasks)
      .set({
        currentTopicId: state.metadata.topicId,
        ...(link ? { totalTopics: sql`coalesce(${tasks.totalTopics}, 0) + 1` } : {}),
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.createdByUserId, job.userId!)));
  });
  const [existing] = await db
    .select({ id: agentRuntimeJobs.id })
    .from(agentRuntimeJobs)
    .where(eq(agentRuntimeJobs.operationId, checkpoint!.id))
    .limit(1);
  if (!existing && state.status === 'idle') {
    guard.assertHeld();
    const { AgentRuntimeService } = await import('@/server/services/agentRuntime');
    await new AgentRuntimeService(db, job.userId!).startExecution({
      operationId: checkpoint!.id,
      nativeWakeLease: { id: job.id, owner: job.leaseOwner! },
    });
  }
  return { receipt: { operationId: checkpoint!.id, recovered: true } };
}

async function updateThread(
  db: LobeChatDatabase,
  job: AgentWakeJob,
  guard: NativeExecutionGuard,
): Promise<WakeResult> {
  const checkpoint = await new NativeAgentStore(db).checkpoint(job.payload.operationId);
  const state = checkpoint?.state;
  if (
    !state ||
    checkpoint?.userId !== job.userId ||
    state.metadata?.threadId !== job.payload.threadId ||
    state.metadata?.sourceMessageId !== job.payload.sourceMessageId
  )
    throw new Error('Thread callback scope mismatch');
  guard.assertHeld();
  await new NativeWakeStore(db).effect({ id: job.id, owner: job.leaseOwner! }, async (tx) => {
    const status =
      state.status === 'done'
        ? 'completed'
        : state.status === 'error'
          ? 'failed'
          : state.status === 'interrupted'
            ? 'cancel'
            : state.status === 'waiting_for_human'
              ? 'inReview'
              : undefined;
    const duration = Date.parse(state.lastModified) - Date.parse(job.payload.startedAt);
    const threadMetadata = {
      operationId: checkpoint!.id,
      startedAt: job.payload.startedAt,
      totalMessages: state.messages?.length ?? 0,
      totalTokens: state.usage?.llm?.tokens?.total,
      totalToolCalls: state.usage?.tools?.totalCalls,
      totalCost: state.cost?.total,
      ...(state.error
        ? {
            error: {
              message:
                state.error.message ??
                state.error.body?.message ??
                state.error.errorType ??
                'Agent execution failed',
            },
          }
        : {}),
      ...(Number.isFinite(duration) ? { duration: Math.max(0, duration) } : {}),
      ...(status && status !== 'inReview' ? { completedAt: state.lastModified } : {}),
    };
    await tx
      .update(threads)
      .set({
        ...(status ? { status } : {}),
        metadata: sql`coalesce(${threads.metadata}, '{}'::jsonb) || ${JSON.stringify(threadMetadata)}::jsonb`,
      })
      .where(and(eq(threads.id, job.payload.threadId), eq(threads.userId, job.userId!)));
    if (status && status !== 'inReview') {
      const content = state.messages
        ?.slice()
        .reverse()
        .find((message: any) => message.role === 'assistant' && message.content)?.content;
      if (typeof content === 'string')
        await tx
          .update(messages)
          .set({ content })
          .where(
            and(eq(messages.id, job.payload.sourceMessageId), eq(messages.userId, job.userId!)),
          );
    }
  });
  return { receipt: { operationId: checkpoint!.id, status: state.status } };
}

async function scanNightly(
  db: LobeChatDatabase,
  job: AgentWakeJob,
  guard: NativeExecutionGuard,
): Promise<WakeResult> {
  const { AgentSignalNightlyReviewModel } =
    await import('@/database/models/agentSignal/nightlyReview');
  const { createSelfReviewScheduleService } =
    await import('@/server/services/agentSignal/services/selfIteration/review/schedule');
  const { enqueueAgentSignalSourceEvent } = await import('@/server/services/agentSignal/emitter');
  const model = new AgentSignalNightlyReviewModel(db);
  const cursor = job.payload.cursor
    ? { ...job.payload.cursor, createdAt: new Date(job.payload.cursor.createdAt) }
    : undefined;
  const users = await model.listEligibleUsers({ cursor, limit: 100 });
  const service = createSelfReviewScheduleService({
    listEligibleUsers: async () => users,
    listActiveAgentTargets: ({ userId, ...options }) =>
      model.listActiveAgentTargets(userId, options),
    enqueueSource: (input) => {
      guard.assertHeld();
      return enqueueAgentSignalSourceEvent(input, {
        userId: input.payload.userId,
        agentId: input.payload.agentId,
      });
    },
  });
  const summary = await service.dispatchNightlyReviewRequests({ limit: 100, targetLimit: 20 });
  const last = users.at(-1);
  return {
    receipt: summary,
    recurring:
      users.length === 100 && last?.createdAt
        ? {
            payload: { cursor: { id: last.id, createdAt: last.createdAt.toISOString() } },
            delay: 0,
          }
        : { payload: {}, delay: 3_600_000 },
  };
}

export function createNativeWakeExecutor(db: LobeChatDatabase) {
  return async (job: AgentWakeJob, guard: NativeExecutionGuard): Promise<WakeResult> => {
    guard.assertHeld();
    if (job.kind === 'scan-tasks') return scanNativeTasks(db, job, guard);
    if (job.kind === 'scan-nightly') return scanNightly(db, job, guard);
    if (!job.userId) throw new Error('Wake owner required');
    if (job.kind === 'agent-signal') {
      if (job.payload.userId !== job.userId) throw new Error('AgentSignal owner mismatch');
      const { runAgentSignalWorkflow } = await import('@/server/workflows/agentSignal/run');
      const outcome = await runAgentSignalWorkflow(
        {
          requestPayload: job.payload as any,
          run: async (_id, handler) => {
            guard.assertHeld();
            const result = await handler();
            guard.assertHeld();
            return result;
          },
        },
        { getDb: async () => db },
      );
      if (!outcome.success) throw new Error('AGENT_SIGNAL_WORKFLOW_INVALID_PAYLOAD');
      return { receipt: { completed: true, ...outcome } };
    }
    if (job.kind === 'thread-step' || job.kind === 'thread-complete')
      return updateThread(db, job, guard);
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, job.payload.taskId), eq(tasks.createdByUserId, job.userId)));
    if (!task) return { receipt: { skipped: 'task-not-found' } };
    if (job.kind === 'task-complete') {
      const checkpoint = await new NativeAgentStore(db).checkpoint(job.payload.operationId);
      if (
        checkpoint?.userId !== job.userId ||
        checkpoint.state?.metadata?.taskId !== task.id ||
        checkpoint.state?.metadata?.topicId !== job.payload.topicId
      )
        throw new Error('Task completion scope mismatch');
      if (
        ['paused', 'canceled', 'completed'].includes(task.status) ||
        (checkpoint.state.metadata.nativeTaskVersion &&
          checkpoint.state.metadata.nativeTaskVersion !== taskWakeVersion(task))
      ) {
        guard.assertHeld();
        await new NativeWakeStore(db).effect({ id: job.id, owner: job.leaseOwner! }, async (tx) => {
          await tx
            .update(taskTopics)
            .set({
              status:
                job.payload.reason === 'done'
                  ? 'completed'
                  : job.payload.reason === 'error'
                    ? 'failed'
                    : 'canceled',
            })
            .where(
              and(
                eq(taskTopics.taskId, task.id),
                eq(taskTopics.topicId, job.payload.topicId),
                eq(taskTopics.userId, job.userId!),
              ),
            );
        });
        return { receipt: { skipped: 'task-control-changed', resultRetained: true } };
      }
      const { TaskLifecycleService } = await import('@/server/services/taskLifecycle');
      await new TaskLifecycleService(db, job.userId, guard).onTopicComplete({
        ...job.payload,
        taskId: task.id,
        taskIdentifier: task.identifier,
        operationId: job.payload.operationId,
        reason: job.payload.reason,
      });
      return { receipt: { completed: true } };
    }
    if (!['heartbeat', 'schedule'].includes(job.kind))
      throw new Error('Unknown native wake handler');
    if (
      taskWakeVersion(task) !== job.payload.version ||
      ['completed', 'failed', 'canceled'].includes(task.status) ||
      (task.status === 'paused' && !job.payload.allowPaused)
    )
      return { receipt: { skipped: 'task-changed' } };
    if (job.payload.resumeOperationId) return resumePreparedTask(db, job, guard);
    if (
      (job.kind === 'heartbeat' && taskWakeAnchor(task) !== job.payload.anchor) ||
      (job.kind === 'schedule' &&
        task.lastHeartbeatAt &&
        task.lastHeartbeatAt.getTime() >= new Date(job.payload.slot).getTime())
    )
      return { receipt: { skipped: 'stale-occurrence' } };
    const options = {
      db,
      nativeWakeId: job.id,
      nativeWakeLease: { id: job.id, owner: job.leaseOwner! },
      guard,
    };
    const outcome =
      job.kind === 'heartbeat'
        ? await (
            await import('@/server/services/taskRunner/heartbeatTick')
          ).runHeartbeatTick(task.id, job.userId, options)
        : await (
            await import('@/server/services/taskRunner/scheduleTick')
          ).runScheduleTick(task.id, job.userId, options);
    if (!outcome.ran && ['human-waiting', 'in-flight'].includes(outcome.reason))
      return { receipt: outcome, recurring: { payload: job.payload, delay: 30_000 } };
    return { receipt: outcome };
  };
}

/** Resolve trusted handlers before the host admits any work. No task is executed here. */
export async function preloadNativeWakeHandlers() {
  await Promise.all([
    import('@/server/services/taskRunner/heartbeatTick'),
    import('@/server/services/taskRunner/scheduleTick'),
    import('@/server/workflows/agentSignal/run'),
    import('@/server/services/taskLifecycle'),
    import('@/server/services/agentSignal/services/selfIteration/review/schedule'),
  ]);
}
