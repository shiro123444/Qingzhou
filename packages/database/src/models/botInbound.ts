import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import { botDeliveryAudits } from '../schemas/botDelivery';
import {
  botExecutionSessions as sessions,
  botInboundEvents as events,
  botPollingCursors as cursors,
  type BotInboundEvent,
} from '../schemas/botInbound';
import type { LobeChatDatabase, Transaction } from '../type';

const now = sql`clock_timestamp()`;
export class BotInboundModel {
  constructor(private readonly db: LobeChatDatabase) {}

  private transaction<T>(fn: (tx: Transaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      return fn(tx);
    });
  }

  async enqueue(
    input: Pick<
      BotInboundEvent,
      | 'id'
      | 'userId'
      | 'platform'
      | 'applicationId'
      | 'threadId'
      | 'eventId'
      | 'payload'
      | 'payloadHash'
    > & { isControl?: boolean },
  ) {
    return this.transaction(async (tx) => {
      await tx.insert(events).values(input).onConflictDoNothing();
      const [row] = await tx.select().from(events).where(eq(events.id, input.id));
      if (!row || row.userId !== input.userId || row.payloadHash !== input.payloadHash)
        throw new Error('inbound_payload_conflict');
      return { id: row.id, status: row.status };
    });
  }

  async claim(controlsOnly = false): Promise<BotInboundEvent | null> {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(events)
        .where(
          and(
            eq(events.status, 'pending'),
            lte(events.nextAttemptAt, now),
            controlsOnly ? eq(events.isControl, true) : undefined,
            sql`not exists (select 1 from bot_inbound_events active where active.user_id = ${events.userId}
            and active.platform = ${events.platform} and active.application_id = ${events.applicationId}
            and active.thread_id = ${events.threadId} and active.id <> ${events.id}
            and (${events.isControl} = false or active.is_control = true)
            and (active.status in ('running','unknown') or
              (active.status = 'pending' and (active.created_at, active.id) < (${events.createdAt}, ${events.id}))))`,
          ),
        )
        .orderBy(sql`${events.isControl} desc`, asc(events.createdAt), asc(events.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      const [job] = await tx
        .update(events)
        .set({
          status: 'running',
          attempts: row.attempts + 1,
          leaseOwner: randomUUID(),
          leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          updatedAt: now,
        })
        .where(eq(events.id, row.id))
        .returning();
      return job;
    });
  }

  private fence(job: BotInboundEvent) {
    return and(
      eq(events.id, job.id),
      eq(events.leaseOwner, job.leaseOwner!),
      eq(events.status, 'running'),
      sql`${events.leaseExpiresAt} > clock_timestamp()`,
    );
  }
  async beginDispatch(job: BotInboundEvent) {
    return (
      (
        await this.db
          .update(events)
          .set({ dispatchStartedAt: now, updatedAt: now })
          .where(this.fence(job))
          .returning({ id: events.id })
      ).length === 1
    );
  }
  async renew(job: BotInboundEvent) {
    return (
      (
        await this.db
          .update(events)
          .set({ leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: now })
          .where(this.fence(job))
          .returning({ id: events.id })
      ).length === 1
    );
  }
  async finish(job: BotInboundEvent) {
    return (
      (
        await this.db
          .update(events)
          .set({
            status: 'processed',
            payload: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(this.fence(job))
          .returning({ id: events.id })
      ).length === 1
    );
  }
  async fail(job: BotInboundEvent, dispatched: boolean, code = 'inbound_failed') {
    await this.db
      .update(events)
      .set({
        status: dispatched
          ? 'unknown'
          : code !== 'session_busy' && job.attempts >= 8
            ? 'dead'
            : 'pending',
        attempts: code === 'session_busy' ? Math.max(0, job.attempts - 1) : job.attempts,
        dispatchStartedAt: dispatched ? now : null,
        errorCode: code,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: sql`clock_timestamp() + ${Math.min(300, 2 ** job.attempts)} * interval '1 second'`,
        updatedAt: now,
      })
      .where(this.fence(job));
  }
  async recover() {
    // Once dispatch begins it may have started an agent/tool or sent a command reply.
    // Never blindly restart that side effect after a worker dies.
    return (
      await this.db
        .update(events)
        .set({
          status: sql`case when ${events.dispatchStartedAt} is not null then 'unknown'
        when ${events.attempts} >= 8 then 'dead' else 'pending' end`,
          errorCode: 'inbound_worker_expired',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(events.status, 'running'), lte(events.leaseExpiresAt, now)))
        .returning({ id: events.id })
    ).length;
  }
  async list(userId: string) {
    return this.db
      .select({
        id: events.id,
        platform: events.platform,
        applicationId: events.applicationId,
        threadId: events.threadId,
        eventId: events.eventId,
        status: events.status,
        attempts: events.attempts,
        errorCode: events.errorCode,
        createdAt: events.createdAt,
        updatedAt: events.updatedAt,
      })
      .from(events)
      .where(eq(events.userId, userId))
      .orderBy(sql`${events.createdAt} desc`)
      .limit(100);
  }

  async reconcile(
    userId: string,
    input: {
      id: string;
      expectedUpdatedAt: string;
      resolution: 'processed' | 'retry';
      note: string;
      evidence: string;
    },
  ) {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(events)
        .where(
          and(
            eq(events.userId, userId),
            eq(events.id, input.id),
            sql`${events.status} in ('unknown','dead')`,
            sql`${events.updatedAt} < clock_timestamp() - interval '60 seconds'`,
          ),
        )
        .for('update');
      if (!row || (input.resolution === 'retry' && !row.payload))
        throw new Error('inbound_reconciliation_conflict');
      if (row.updatedAt.toISOString() !== input.expectedUpdatedAt)
        throw new Error('inbound_reconciliation_conflict');
      await tx
        .update(events)
        .set({
          status: input.resolution === 'retry' ? 'pending' : 'processed',
          payload: input.resolution === 'retry' ? row.payload : null,
          attempts: 0,
          dispatchStartedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          nextAttemptAt: now,
          updatedAt: now,
        })
        .where(eq(events.id, row.id));
      await tx.insert(botDeliveryAudits).values({
        id: randomUUID(),
        userId,
        actorId: userId,
        scopeKey: row.id,
        jobId: row.id,
        action: input.resolution === 'retry' ? 'retry_dead' : 'confirmed_delivered',
        note: input.note,
        evidence: input.evidence,
      });
    });
  }

  async getCursor(scopeKey: string) {
    const [row] = await this.db.select().from(cursors).where(eq(cursors.scopeKey, scopeKey));
    return row?.cursor;
  }
  async saveCursor(scopeKey: string, cursor: string) {
    await this.db
      .insert(cursors)
      .values({ scopeKey, cursor })
      .onConflictDoUpdate({ target: cursors.scopeKey, set: { cursor, updatedAt: now } });
  }

  async acquireSession(userId: string, scopeKey: string): Promise<string | null> {
    const owner = randomUUID();
    const rows = await this.db
      .insert(sessions)
      .values({
        userId,
        scopeKey,
        owner,
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .onConflictDoUpdate({
        target: sessions.scopeKey,
        set: {
          owner,
          operationId: null,
          stopRequested: 0,
          leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          updatedAt: now,
        },
        setWhere: and(
          eq(sessions.userId, userId),
          isNull(sessions.operationId),
          lte(sessions.leaseExpiresAt, now),
        ),
      })
      .returning({ owner: sessions.owner });
    return rows[0]?.owner ?? null;
  }
  async getSession(userId: string, scopeKey: string) {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.scopeKey, scopeKey)));
    return row && (row.operationId || row.leaseExpiresAt.getTime() > Date.now()) ? row : null;
  }
  async renewSession(userId: string, scopeKey: string, owner: string) {
    return (
      (
        await this.db
          .update(sessions)
          .set({ leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: now })
          .where(
            and(
              eq(sessions.userId, userId),
              eq(sessions.scopeKey, scopeKey),
              eq(sessions.owner, owner),
              sql`(${sessions.operationId} is not null or ${sessions.leaseExpiresAt} > clock_timestamp())`,
            ),
          )
          .returning({ id: sessions.scopeKey })
      ).length === 1
    );
  }
  async attachOperation(
    userId: string,
    scopeKey: string,
    owner: string,
    operationId: string,
  ): Promise<{ stopRequested: number } | undefined> {
    return (
      await this.db
        .update(sessions)
        .set({ operationId, updatedAt: now })
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.scopeKey, scopeKey),
            eq(sessions.owner, owner),
            sql`${sessions.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ stopRequested: sessions.stopRequested })
    )[0];
  }
  async requestStop(userId: string, scopeKey: string) {
    return (
      await this.db
        .update(sessions)
        .set({ stopRequested: 1, updatedAt: now })
        .where(and(eq(sessions.userId, userId), eq(sessions.scopeKey, scopeKey)))
        .returning({ operationId: sessions.operationId })
    )[0];
  }
  async releaseSession(
    userId: string,
    scopeKey: string,
    identity: { owner?: string; operationId?: string },
  ) {
    if (!identity.owner && !identity.operationId) throw new Error('session_identity_required');
    await this.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.scopeKey, scopeKey),
          identity.owner
            ? eq(sessions.owner, identity.owner)
            : eq(sessions.operationId, identity.operationId!),
        ),
      );
  }

  async recoverTerminalSessions() {
    // Expiry alone is insufficient: require the owning operation's persisted terminal state.
    return this.transaction(
      async (tx) =>
        (
          await tx
            .delete(sessions)
            .where(
              and(
                lte(sessions.leaseExpiresAt, now),
                sql`exists (select 1 from agent_operations operation where operation.id = ${sessions.operationId}
        and operation.user_id = ${sessions.userId} and operation.status in ('done','error','interrupted'))`,
              ),
            )
            .returning({ id: sessions.scopeKey })
        ).length,
    );
  }
}
