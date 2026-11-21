import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

import { agentRuntimeCheckpoints } from '@/database/schemas/agentRuntime';
import { agentWakeJobs as jobs } from '@/database/schemas/agentWake';
import { tasks } from '@/database/schemas/task';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { taskWakeVersion, wakeHash } from './wakeIdentity';

export { wakeHash } from './wakeIdentity';

export const WAKE_KINDS = [
  'heartbeat',
  'schedule',
  'agent-signal',
  'task-complete',
  'thread-step',
  'thread-complete',
  'scan-tasks',
  'scan-nightly',
] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];
export interface WakeInput {
  availableAt?: Date;
  key: string;
  kind: WakeKind;
  payload: Record<string, any>;
  scopeKey: string;
  userId?: string | null;
}
const now = sql`clock_timestamp()`;
export type WakeLease = { id: string; owner: string };
const fence = (lease: WakeLease) =>
  and(
    eq(jobs.id, lease.id),
    eq(jobs.leaseOwner, lease.owner),
    inArray(jobs.status, ['claimed', 'dispatched']),
    sql`${jobs.leaseUntil} > clock_timestamp()`,
  );
const replaySafe = (kind: string) =>
  ['scan-tasks', 'scan-nightly', 'thread-step', 'thread-complete'].includes(kind);

/** Durable wake intents and callback commands; only registered handlers may execute them. */
export class NativeWakeStore {
  constructor(private readonly database: LobeChatDatabase | (() => Promise<LobeChatDatabase>)) {}
  async db() {
    return typeof this.database === 'function' ? this.database() : this.database;
  }
  async ready() {
    await (await this.db()).select({ id: jobs.id }).from(jobs).limit(0);
  }
  private async transaction<T>(run: (tx: Transaction) => Promise<T>) {
    return (await this.db()).transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      return run(tx);
    });
  }
  async enqueue(input: WakeInput, tx?: Transaction) {
    if (
      !WAKE_KINDS.includes(input.kind) ||
      !input.key ||
      !input.scopeKey ||
      (!input.userId && !input.kind.startsWith('scan-'))
    )
      throw new Error('NATIVE_WAKE_INVALID_SCOPE');
    if (input.userId && input.kind.startsWith('scan-'))
      throw new Error('NATIVE_WAKE_INVALID_SCOPE');
    const scopeKey = wakeHash([input.userId ?? null, input.scopeKey]);
    const id = wakeHash([input.userId ?? null, input.kind, input.key]);
    // Normalize Dates/undefined to the persisted JSON transport format.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const payload = JSON.parse(JSON.stringify(input.payload));
    if (Buffer.byteLength(JSON.stringify(payload)) > 2_000_000)
      throw new Error('NATIVE_WAKE_PAYLOAD_LIMIT');
    const intentPayload =
      input.kind === 'agent-signal'
        ? {
            ...payload,
            sourceEvent: {
              ...payload.sourceEvent,
              timestamp: undefined,
              payload: { ...payload.sourceEvent?.payload, requestedAt: undefined },
            },
          }
        : payload;
    const intentHash = wakeHash([input.kind, input.userId, input.scopeKey, intentPayload]);
    const run = async (connection: Transaction) => {
      await connection
        .insert(jobs)
        .values({
          id,
          kind: input.kind,
          userId: input.userId ?? null,
          scopeKey,
          payload,
          intentHash,
          availableAt: input.availableAt ?? new Date(),
        })
        .onConflictDoNothing();
      const [row] = await connection.select().from(jobs).where(eq(jobs.id, id));
      if (row.intentHash !== intentHash && !input.kind.startsWith('scan-'))
        throw new Error('NATIVE_WAKE_PAYLOAD_CONFLICT');
      return id;
    };
    return tx ? run(tx) : this.transaction(run);
  }
  async seedScanners() {
    for (const kind of ['scan-tasks', 'scan-nightly'] as const)
      await this.enqueue({ kind, key: kind, scopeKey: kind, payload: {} });
  }
  async cancel(userId: string, id: string) {
    await (
      await this.db()
    )
      .update(jobs)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), eq(jobs.status, 'queued')));
  }
  async claim() {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, 'queued'),
            lte(jobs.availableAt, now),
            sql`not exists (select 1 from agent_wake_jobs active where active.scope_key = ${jobs.scopeKey} and active.id <> ${jobs.id} and active.status in ('claimed','dispatched','unknown'))`,
          ),
        )
        .orderBy(asc(jobs.availableAt), asc(jobs.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      // Serialize the scope across transactions selecting different ready rows in that scope.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${row.scopeKey}, 0))`);
      const [busy] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.scopeKey, row.scopeKey),
            inArray(jobs.status, ['claimed', 'dispatched', 'unknown']),
          ),
        )
        .limit(1);
      if (busy) return null;
      const [claimed] = await tx
        .update(jobs)
        .set({
          status: 'claimed',
          leaseOwner: randomUUID(),
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
          attempts: row.attempts + 1,
          updatedAt: now,
        })
        .where(eq(jobs.id, row.id))
        .returning();
      return claimed;
    });
  }
  async dispatch(lease: WakeLease) {
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({ status: 'dispatched', updatedAt: now })
        .where(and(fence(lease), eq(jobs.status, 'claimed')))
        .returning({ id: jobs.id })
    ).length;
  }
  async renew(lease: WakeLease) {
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
        .where(fence(lease))
        .returning({ id: jobs.id })
    ).length;
  }
  async finish(
    lease: WakeLease,
    receipt: Record<string, any>,
    recurring?: { payload: Record<string, any>; delay: number },
  ) {
    return !!(
      await (
        await this.db()
      )
        .update(jobs)
        .set({
          status: recurring ? 'queued' : 'done',
          receipt,
          leaseOwner: null,
          leaseUntil: null,
          errorCode: null,
          updatedAt: now,
          ...(recurring
            ? { payload: recurring.payload, availableAt: new Date(Date.now() + recurring.delay) }
            : {}),
        })
        .where(fence(lease))
        .returning({ id: jobs.id })
    ).length;
  }
  async fail(lease: WakeLease, dispatched: boolean) {
    return this.transaction(async (tx) => {
      const [row] = await tx.select().from(jobs).where(fence(lease)).for('update');
      if (!row) return;
      let safe = !dispatched || replaySafe(row.kind);
      let payload = row.payload;
      if (!safe && ['heartbeat', 'schedule'].includes(row.kind)) {
        const [operation] = await tx
          .select({ id: agentRuntimeCheckpoints.id })
          .from(agentRuntimeCheckpoints)
          .where(
            and(
              eq(agentRuntimeCheckpoints.userId, row.userId!),
              sql`${agentRuntimeCheckpoints.state}->'metadata'->>'nativeWakeId' = ${row.id}`,
            ),
          )
          .limit(1);
        if (operation) {
          safe = true;
          payload = { ...payload, resumeOperationId: operation.id };
        }
      }
      if (!safe) await this.pauseUnknownTask(tx, row);
      const updated = await tx
        .update(jobs)
        .set({
          status: safe ? 'queued' : 'unknown',
          payload,
          errorCode: safe ? 'wake_retry_pending' : 'wake_outcome_unknown',
          leaseOwner: null,
          leaseUntil: null,
          availableAt: new Date(Date.now() + 5_000),
          updatedAt: now,
        })
        .where(fence(lease))
        .returning({ id: jobs.id });
      if (!updated.length) throw new Error('NATIVE_WAKE_LEASE_LOST');
    });
  }
  async recover() {
    return this.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(and(inArray(jobs.status, ['claimed', 'dispatched']), lte(jobs.leaseUntil, now)))
        .limit(32)
        .for('update', { skipLocked: true });
      for (const row of rows) {
        let safe = row.status === 'claimed' || replaySafe(row.kind);
        let payload = row.payload;
        if (!safe && ['heartbeat', 'schedule'].includes(row.kind)) {
          const [operation] = await tx
            .select({ id: agentRuntimeCheckpoints.id })
            .from(agentRuntimeCheckpoints)
            .where(
              and(
                eq(agentRuntimeCheckpoints.userId, row.userId!),
                sql`${agentRuntimeCheckpoints.state}->'metadata'->>'nativeWakeId' = ${row.id}`,
              ),
            )
            .limit(1);
          if (operation) {
            safe = true;
            payload = { ...payload, resumeOperationId: operation.id };
          }
        }
        await tx
          .update(jobs)
          .set({
            status: safe ? 'queued' : 'unknown',
            payload,
            errorCode: safe ? 'wake_recovered' : 'wake_outcome_unknown',
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          })
          .where(eq(jobs.id, row.id));
        if (!safe) await this.pauseUnknownTask(tx, row);
      }
      return rows.length;
    });
  }
  async effect<T>(lease: WakeLease, run: (tx: Transaction) => Promise<T>) {
    return this.transaction(async (tx) => {
      const [held] = await tx.select({ id: jobs.id }).from(jobs).where(fence(lease)).for('update');
      if (!held) throw new Error('NATIVE_WAKE_LEASE_LOST');
      const result = await run(tx);
      const [stillHeld] = await tx.select({ id: jobs.id }).from(jobs).where(fence(lease));
      if (!stillHeld) throw new Error('NATIVE_WAKE_LEASE_LOST');
      return result;
    });
  }
  private async pauseUnknownTask(tx: Transaction, job: typeof jobs.$inferSelect) {
    if (!job.payload.taskId || !job.userId) return;
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, job.payload.taskId), eq(tasks.createdByUserId, job.userId)))
      .for('update');
    if (!task || (job.payload.version && taskWakeVersion(task) !== job.payload.version)) return;
    await tx
      .update(tasks)
      .set({ status: 'paused', error: 'Background execution outcome needs review' })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.createdByUserId, job.userId),
          inArray(tasks.status, ['running', 'scheduled', 'backlog']),
        ),
      );
  }
}
