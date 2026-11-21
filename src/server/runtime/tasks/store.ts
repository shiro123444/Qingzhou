import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, getTableColumns, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { BotDeliveryModel } from '@/database/models/botDelivery';
import { agentOperations } from '@/database/schemas/agentOperations';
import {
  agentRuntimeCheckpoints as checkpoints,
  agentRuntimeJobs as jobs,
} from '@/database/schemas/agentRuntime';
import { agentWakeJobs } from '@/database/schemas/agentWake';
import { tasks } from '@/database/schemas/task';
import { topics } from '@/database/schemas/topic';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  AgentOperationMetadata,
  StepResult,
} from '@/server/modules/AgentRuntime/AgentStateManager';
import type { StepLease } from '@/server/modules/AgentRuntime/types';
import { deliveryEnvelope } from '@/server/services/bot/deliveryEnvelope';
import type { QueueMessage, QueueStats } from '@/server/services/queue/types';

import { collectNativeCallbackIntents } from './wakeHooks';
import { taskWakeVersion } from './wakeScheduling';
import { NativeWakeStore, type WakeInput } from './wakeStore';

const now = sql`clock_timestamp()`;
// Normalize to the transport representation, including Dates and omitted undefined fields.
// eslint-disable-next-line unicorn/prefer-structured-clone
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const canonical = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonical(wire(value)))
    .digest('hex');
const terminal = (state?: Record<string, any> | null) =>
  !!state && ['done', 'error', 'interrupted'].includes(state.status);
const checkpointFence = (lease: StepLease) =>
  and(
    eq(checkpoints.id, lease.operationId),
    eq(checkpoints.leaseOwner, lease.ownerToken),
    eq(checkpoints.leaseStep, lease.stepIndex),
    sql`${checkpoints.leaseUntil} > clock_timestamp()`,
  );
export interface NativeJobLease {
  id: string;
  owner: string;
}
const jobFence = (lease: NativeJobLease) =>
  and(
    eq(jobs.id, lease.id),
    eq(jobs.leaseOwner, lease.owner),
    inArray(jobs.status, ['claimed', 'dispatched']),
    sql`${jobs.leaseUntil} > clock_timestamp()`,
  );
class LostLease extends Error {}

/** SQL owns checkpoints, step continuations and dispatch identity. No model/network work runs in a transaction. */
export class NativeAgentStore {
  constructor(private readonly database: LobeChatDatabase | (() => Promise<LobeChatDatabase>)) {}
  async db() {
    return typeof this.database === 'function' ? this.database() : this.database;
  }
  private async transaction<T>(run: (tx: Transaction) => Promise<T>) {
    return (await this.db()).transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      return run(tx);
    });
  }
  async checkpoint(operationId: string) {
    const [row] = await (
      await this.db()
    )
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, operationId));
    return row;
  }
  async hasPendingIntervention(operationId: string, stepIndex: number) {
    const [row] = await (
      await this.db()
    )
      .select({ message: jobs.message })
      .from(jobs)
      .where(
        and(
          eq(jobs.operationId, operationId),
          eq(jobs.stepIndex, stepIndex),
          inArray(jobs.status, ['queued', 'claimed', 'dispatched']),
        ),
      )
      .limit(1);
    const payload = row?.message.payload;
    return !!(payload?.approvedToolCall || payload?.humanInput || payload?.rejectionReason);
  }
  async attachConversation(
    operationId: string,
    userId: string,
    pointer: {
      topicId: string;
      assistantMessageId: string;
      scope?: string;
      threadId?: string | null;
    },
  ) {
    return this.transaction(async (tx) => {
      const [checkpoint] = await tx
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.id, operationId), eq(checkpoints.userId, userId)))
        .for('update');
      if (!checkpoint?.state || checkpoint.state.metadata?.topicId !== pointer.topicId)
        throw new Error('NATIVE_CONVERSATION_SCOPE_MISMATCH');
      if (terminal(checkpoint.state)) return;
      const { topicId, ...data } = pointer;
      await tx
        .update(topics)
        .set({
          status: 'running',
          metadata: sql`coalesce(${topics.metadata}, '{}'::jsonb) || ${JSON.stringify({ runningOperation: { ...data, operationId, transport: 'native' } })}::jsonb`,
        })
        .where(and(eq(topics.id, topicId), eq(topics.userId, userId)));
    });
  }
  async create(operationId: string, data: Partial<AgentOperationMetadata>) {
    if (!data.userId) throw new Error('NATIVE_RUNTIME_OWNER_REQUIRED');
    const metadata = wire({
      ...data,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'idle',
      totalCost: 0,
      totalSteps: 0,
    });
    await this.transaction(async (tx) => {
      const created = await tx
        .insert(checkpoints)
        .values({ id: operationId, userId: data.userId!, metadata })
        .onConflictDoNothing()
        .returning({ id: checkpoints.id });
      const [row] = await tx.select().from(checkpoints).where(eq(checkpoints.id, operationId));
      if (row?.userId !== data.userId) throw new Error('NATIVE_RUNTIME_OWNER_MISMATCH');
      if (!created.length) throw new Error('NATIVE_RUNTIME_OPERATION_EXISTS');
    });
  }
  private async enqueueIn(
    tx: Transaction,
    userId: string,
    input: QueueMessage,
    state: Record<string, any>,
  ) {
    const message = wire(input);
    if (!Number.isSafeInteger(message.stepIndex) || message.stepIndex < 0 || !message.operationId)
      throw new Error('NATIVE_QUEUE_INVALID_STEP');
    if (
      !Number.isFinite(message.delay ?? 0) ||
      (message.delay ?? 0) < 0 ||
      (message.delay ?? 0) > 86_400_000
    )
      throw new Error('NATIVE_QUEUE_INVALID_DELAY');
    const id = hash([userId, message.operationId, message.stepIndex]);
    // Transport timing/retry hints cannot change the meaning of an accepted step.
    const intentHash = hash({
      operationId: message.operationId,
      stepIndex: message.stepIndex,
      context: message.context,
      payload: message.payload,
    });
    const [previous] = await tx.select().from(jobs).where(eq(jobs.id, id));
    if (previous) {
      if (previous.intentHash !== intentHash) throw new Error('NATIVE_QUEUE_PAYLOAD_CONFLICT');
      if (['unknown', 'cancelled', 'failed'].includes(previous.status))
        throw new Error('NATIVE_QUEUE_REVIEW_REQUIRED');
      return previous.id;
    }
    if (terminal(state) || message.stepIndex !== state.stepCount)
      throw new Error('NATIVE_QUEUE_STALE_STEP');
    if (JSON.stringify(message).length > 2_000_000) throw new Error('NATIVE_QUEUE_PAYLOAD_LIMIT');
    await tx.insert(jobs).values({
      id,
      intentHash,
      message,
      operationId: message.operationId,
      userId,
      stepIndex: message.stepIndex,
      priority: message.priority === 'high' ? 1 : message.priority === 'low' ? -1 : 0,
      availableAt: sql`clock_timestamp() + ${message.delay ?? 50} * interval '1 millisecond'`,
    });
    return id;
  }
  async enqueue(userId: string, message: QueueMessage) {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.id, message.operationId), eq(checkpoints.userId, userId)))
        .for('update');
      if (!row?.state) throw new Error('NATIVE_RUNTIME_CHECKPOINT_MISSING');
      return this.enqueueIn(tx, userId, message, row.state);
    });
  }
  async save(
    operationId: string,
    stateInput: Record<string, any>,
    lease?: StepLease,
    result?: StepResult,
  ): Promise<boolean> {
    if (lease && lease.operationId !== operationId)
      throw new Error('Step lease operation mismatch');
    try {
      return await this.transaction(async (tx) => {
        const admission = !lease ? stateInput.metadata?._nativeAdmissionLease : undefined;
        const checkAdmission = async () => {
          if (!admission) return;
          const [held] = await tx
            .select()
            .from(agentWakeJobs)
            .where(
              and(
                eq(agentWakeJobs.id, admission.id),
                eq(agentWakeJobs.leaseOwner, admission.owner),
                eq(agentWakeJobs.status, 'dispatched'),
                sql`${agentWakeJobs.leaseUntil} > clock_timestamp()`,
              ),
            )
            .for('update');
          if (!held) throw new Error('NATIVE_WAKE_LEASE_LOST');
          const [task] = await tx
            .select()
            .from(tasks)
            .where(and(eq(tasks.id, held.payload.taskId), eq(tasks.createdByUserId, held.userId!)))
            .for('update');
          if (!task || task.status !== 'running' || taskWakeVersion(task) !== held.payload.version)
            throw new Error('NATIVE_WAKE_TASK_CHANGED');
        };
        const [row] = await tx
          .select({
            ...getTableColumns(checkpoints),
            liveLease: sql<boolean>`${checkpoints.leaseUntil} > clock_timestamp()`,
          })
          .from(checkpoints)
          .where(lease ? checkpointFence(lease) : eq(checkpoints.id, operationId))
          .for('update');
        if (!row) {
          if (lease) throw new LostLease();
          throw new Error('NATIVE_RUNTIME_CHECKPOINT_MISSING');
        }
        if (stateInput.metadata?.userId !== row.userId)
          throw new Error('NATIVE_RUNTIME_OWNER_MISMATCH');
        const cancelling = !lease && stateInput.status === 'interrupted';
        if (!lease && row.liveLease && !cancelling) throw new Error('NATIVE_RUNTIME_STEP_BUSY');
        if (!cancelling && row.state && stateInput.stepCount < row.state.stepCount)
          throw new Error('NATIVE_RUNTIME_STALE_CHECKPOINT');
        if (cancelling && terminal(row.state)) throw new Error('NATIVE_RUNTIME_ALREADY_TERMINAL');
        const state = wire(
          cancelling
            ? {
                ...row.state,
                status: 'interrupted',
                interruption: stateInput.interruption,
                lastModified: stateInput.lastModified,
              }
            : stateInput,
        );
        await checkAdmission();
        if (state.metadata) delete state.metadata._nativeAdmissionLease;
        const metadata = {
          ...row.metadata,
          status: state.status,
          totalCost: state.cost?.total ?? 0,
          totalSteps: state.stepCount,
          lastActiveAt: new Date().toISOString(),
        };
        const history = result
          ? [
              {
                context: result.nextContext ? { phase: result.nextContext.phase } : undefined,
                cost: state.cost?.total ?? 0,
                executionTime: result.executionTime,
                status: state.status,
                stepIndex: result.stepIndex,
                timestamp: Date.now(),
              },
              ...row.history,
            ].slice(0, 200)
          : row.history;
        await tx
          .update(checkpoints)
          .set({
            state,
            metadata,
            history: wire(history),
            updatedAt: now,
            ...(cancelling ? { leaseOwner: null, leaseStep: null, leaseUntil: null } : {}),
          })
          .where(eq(checkpoints.id, operationId));
        if (terminal(state) && state.metadata?.topicId) {
          await tx
            .update(topics)
            .set({
              metadata: sql`coalesce(${topics.metadata}, '{}'::jsonb) - 'runningOperation'`,
              ...(!state.metadata.taskId ? { status: 'active' } : {}),
            })
            .where(
              and(
                eq(topics.id, state.metadata.topicId),
                eq(topics.userId, row.userId),
                sql`${topics.metadata}->'runningOperation'->>'operationId' = ${operationId}`,
              ),
            );
        }
        if (['running', 'waiting_for_human'].includes(state.status) && state.metadata?.topicId)
          await tx
            .update(topics)
            .set({ status: state.status === 'waiting_for_human' ? 'waitingForHuman' : 'running' })
            .where(
              and(
                eq(topics.id, state.metadata.topicId),
                eq(topics.userId, row.userId),
                sql`${topics.metadata}->'runningOperation'->>'operationId' = ${operationId}`,
              ),
            );
        if (cancelling) {
          await tx
            .update(jobs)
            .set({
              status: 'cancelled',
              errorCode: 'operation_cancelled',
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(jobs.operationId, operationId),
                inArray(jobs.status, ['queued', 'claimed', 'dispatched']),
              ),
            );
        } else {
          const pending = state.metadata?._pendingNextStep as QueueMessage | undefined;
          if (pending && state.status === 'running') {
            if (pending.operationId !== operationId)
              throw new Error('NATIVE_QUEUE_OPERATION_MISMATCH');
            await this.enqueueIn(tx, row.userId, pending, state);
          }
          for (const payload of lease ? (state.metadata?._pendingBotCallbacks ?? []) : []) {
            const envelope = deliveryEnvelope(payload);
            if (envelope.userId !== row.userId || envelope.operationId !== operationId)
              throw new Error('NATIVE_CALLBACK_OWNER_MISMATCH');
            await new BotDeliveryModel(tx as unknown as LobeChatDatabase).enqueue(
              'outbox',
              envelope,
            );
          }
          for (const command of (lease
            ? (state.metadata?._pendingNativeCallbacks ?? [])
            : []) as WakeInput[]) {
            if (command.userId !== row.userId || command.payload.operationId !== operationId)
              throw new Error('NATIVE_CALLBACK_OWNER_MISMATCH');
            await new NativeWakeStore(tx as unknown as LobeChatDatabase).enqueue(command, tx);
          }
        }
        if (lease) {
          const fence = await tx
            .update(checkpoints)
            .set({ updatedAt: now })
            .where(checkpointFence(lease))
            .returning({ id: checkpoints.id });
          if (!fence.length) throw new LostLease();
        }
        await checkAdmission();
        return true;
      });
    } catch (error) {
      if (error instanceof LostLease) return false;
      throw error;
    }
  }
  async acquireStep(operationId: string, stepIndex: number, ttl = 35): Promise<StepLease | null> {
    if (
      !Number.isSafeInteger(stepIndex) ||
      stepIndex < 0 ||
      !Number.isFinite(ttl) ||
      ttl <= 0 ||
      ttl > 300
    )
      throw new Error('NATIVE_RUNTIME_INVALID_LEASE');
    const ownerToken = randomUUID();
    const [row] = await (
      await this.db()
    )
      .update(checkpoints)
      .set({
        leaseOwner: ownerToken,
        leaseStep: stepIndex,
        leaseUntil: sql`clock_timestamp() + ${ttl} * interval '1 second'`,
      })
      .where(
        and(
          eq(checkpoints.id, operationId),
          or(isNull(checkpoints.leaseUntil), lte(checkpoints.leaseUntil, now)),
        ),
      )
      .returning({ id: checkpoints.id });
    return row ? { operationId, stepIndex, ownerToken } : null;
  }
  async renewStep(lease: StepLease, ttl = 35) {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 300)
      throw new Error('NATIVE_RUNTIME_INVALID_LEASE');
    return !!(
      await (
        await this.db()
      )
        .update(checkpoints)
        .set({ leaseUntil: sql`clock_timestamp() + ${ttl} * interval '1 second'` })
        .where(checkpointFence(lease))
        .returning({ id: checkpoints.id })
    ).length;
  }
  async releaseStep(lease: StepLease) {
    return !!(
      await (
        await this.db()
      )
        .update(checkpoints)
        .set({ leaseOwner: null, leaseStep: null, leaseUntil: null })
        .where(
          and(
            eq(checkpoints.id, lease.operationId),
            eq(checkpoints.leaseOwner, lease.ownerToken),
            eq(checkpoints.leaseStep, lease.stepIndex),
          ),
        )
        .returning({ id: checkpoints.id })
    ).length;
  }
  async cancelJob(userId: string, id: string) {
    await (
      await this.db()
    )
      .update(jobs)
      .set({ status: 'cancelled', leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), eq(jobs.status, 'queued')));
  }
  async claim() {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'queued'), lte(jobs.availableAt, now)))
        .orderBy(desc(jobs.priority), asc(jobs.availableAt), asc(jobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const [claimed] = await tx
        .update(jobs)
        .set({
          status: 'claimed',
          attempts: row.attempts + 1,
          leaseOwner: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
          updatedAt: now,
        })
        .where(eq(jobs.id, row.id))
        .returning();
      return claimed;
    });
  }
  async dispatch(lease: NativeJobLease) {
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({ status: 'dispatched', updatedAt: now })
        .where(and(jobFence(lease), eq(jobs.status, 'claimed')))
        .returning({ id: jobs.id })
    ).length;
  }
  async renewJob(lease: NativeJobLease) {
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
        .where(jobFence(lease))
        .returning({ id: jobs.id })
    ).length;
  }
  async finish(lease: NativeJobLease, status: 'done' | 'unknown' | 'queued', errorCode?: string) {
    if (status === 'unknown') {
      return this.transaction(async (tx) => {
        const [candidate] = await tx.select().from(jobs).where(eq(jobs.id, lease.id));
        if (!candidate) return false;
        const [checkpoint] = await tx
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.id, candidate.operationId))
          .for('update');
        const committed =
          checkpoint?.state &&
          (checkpoint.state.stepCount > candidate.stepIndex || terminal(checkpoint.state));
        const updated = await tx
          .update(jobs)
          .set({
            status: committed ? 'done' : 'unknown',
            errorCode: committed ? null : 'execution_outcome_unknown',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(jobFence(lease))
          .returning({ id: jobs.id });
        if (!updated.length) return false;
        if (!committed && checkpoint?.state) await this.blockUnknown(tx, checkpoint);
        return true;
      });
    }
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({
          status,
          errorCode: errorCode ?? null,
          leaseOwner: null,
          leaseUntil: null,
          availableAt: sql`clock_timestamp() + interval '1 second'`,
          updatedAt: now,
        })
        .where(jobFence(lease))
        .returning({ id: jobs.id })
    ).length;
  }
  /** Reclaim undispatched work; quarantine dispatched work unless its authoritative commit is present. */
  async recover() {
    return this.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(jobs)
        .where(and(inArray(jobs.status, ['claimed', 'dispatched']), lte(jobs.leaseUntil, now)))
        .limit(32);
      let recovered = 0;
      for (const candidate of candidates) {
        // All paths lock checkpoint before job, matching state+continuation commits.
        const [checkpoint] = await tx
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.id, candidate.operationId))
          .for('update', { skipLocked: true });
        if (!checkpoint) continue;
        const [row] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, candidate.id),
              inArray(jobs.status, ['claimed', 'dispatched']),
              lte(jobs.leaseUntil, now),
            ),
          )
          .for('update', { skipLocked: true });
        if (!row) continue;
        const committed =
          checkpoint?.state &&
          (checkpoint.state.stepCount > row.stepIndex || terminal(checkpoint.state));
        const status = committed ? 'done' : row.status === 'claimed' ? 'queued' : 'unknown';
        await tx
          .update(jobs)
          .set({
            status,
            leaseOwner: null,
            leaseUntil: null,
            errorCode: status === 'unknown' ? 'execution_outcome_unknown' : 'worker_lease_expired',
            updatedAt: now,
          })
          .where(eq(jobs.id, row.id));
        // Unknown dispatch remains durable and blocks that operation; no automatic tool replay.
        if (status === 'unknown' && checkpoint.state) await this.blockUnknown(tx, checkpoint);
        recovered++;
      }
      return recovered;
    });
  }
  private async blockUnknown(tx: Transaction, checkpoint: typeof checkpoints.$inferSelect) {
    const interruption = {
      canResume: false,
      interruptedAt: new Date().toISOString(),
      reason: 'execution_outcome_unknown',
    };
    await tx
      .update(checkpoints)
      .set({
        state: { ...checkpoint.state, status: 'interrupted', interruption },
        metadata: { ...checkpoint.metadata, status: 'interrupted' },
        leaseOwner: null,
        leaseUntil: null,
        leaseStep: null,
        updatedAt: now,
      })
      .where(eq(checkpoints.id, checkpoint.id));
    await tx
      .update(agentOperations)
      .set({ status: 'interrupted', completionReason: 'interrupted', interruption, updatedAt: now })
      .where(
        and(eq(agentOperations.id, checkpoint.id), eq(agentOperations.userId, checkpoint.userId)),
      );
    const state: Record<string, any> = { ...checkpoint.state, status: 'interrupted', interruption };
    const event = {
      finalState: state,
      operationId: checkpoint.id,
      reason: 'interrupted',
      userId: checkpoint.userId,
      errorMessage: 'Execution outcome needs review',
    };
    for (const command of collectNativeCallbackIntents(
      checkpoint.id,
      'onComplete',
      event as any,
      state.metadata?._hooks,
    ))
      await new NativeWakeStore(tx as unknown as LobeChatDatabase).enqueue(command, tx);
  }
  async stats(userId: string): Promise<QueueStats> {
    const rows = await (
      await this.db()
    )
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.userId, userId))
      .groupBy(jobs.status);
    const count = (statuses: string[]) =>
      rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.count, 0);
    return {
      completedCount: count(['done']),
      failedCount: count(['failed', 'unknown']),
      pendingCount: count(['queued']),
      processingCount: count(['claimed', 'dispatched']),
    };
  }
  async pendingNotifications() {
    return (await this.db())
      .select({ id: jobs.id, operationId: jobs.operationId, stepIndex: jobs.stepIndex })
      .from(jobs)
      .where(and(inArray(jobs.status, ['done', 'unknown', 'cancelled']), isNull(jobs.notifiedAt)))
      .limit(16);
  }
  async acknowledgeNotification(id: string) {
    await (
      await this.db()
    )
      .update(jobs)
      .set({ notifiedAt: now })
      .where(and(eq(jobs.id, id), inArray(jobs.status, ['done', 'unknown', 'cancelled'])));
  }
}
