import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import {
  botDeliveryAudits,
  type BotDeliveryJob,
  botDeliveryJobs,
  botDeliveryLedgers,
  type BotDeliveryLedgerState,
} from '../schemas/botDelivery';
import { users } from '../schemas/user';
import type { LobeChatDatabase, Transaction } from '../type';

export const DELIVERY_MAX_ATTEMPTS = 8;
export interface DeliveryJobLease {
  id: string;
  owner: string;
}
export interface DeliveryEnvelope {
  eventKey: string;
  intentHash: string;
  operationId: string;
  payload: Record<string, unknown>;
  priority: number;
  scopeKey: string;
  userId: string;
}
export class BotDeliveryConflict extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const now = sql`clock_timestamp()`;
const jobLeaseUntil = sql`clock_timestamp() + interval '60 seconds'`;
const ledgerLeaseUntil = sql`clock_timestamp() + interval '30 seconds'`;
const freeLedger = or(
  isNull(botDeliveryLedgers.leaseExpiresAt),
  lte(botDeliveryLedgers.leaseExpiresAt, now),
);
const jobFence = (lease: DeliveryJobLease) =>
  and(
    eq(botDeliveryJobs.id, lease.id),
    eq(botDeliveryJobs.leaseOwner, lease.owner),
    eq(botDeliveryJobs.status, 'running'),
    sql`${botDeliveryJobs.leaseExpiresAt} > clock_timestamp()`,
  );

/** SQL operations are isolated from HTTP/platform effects; no network send occurs in a transaction. */
export class BotDeliveryModel {
  constructor(private readonly db: LobeChatDatabase) {}

  private transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      return run(tx);
    });
  }

  async userExists(userId: string): Promise<boolean> {
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    return !!user;
  }

  async enqueue(role: 'inbox' | 'outbox', envelope: DeliveryEnvelope) {
    return this.transaction(async (tx) => {
      const id = `${role}:${envelope.eventKey}`;
      await tx
        .insert(botDeliveryJobs)
        .values({ ...envelope, id, payload: JSON.stringify(envelope.payload), role })
        .onConflictDoNothing();
      const [job] = await tx.select().from(botDeliveryJobs).where(eq(botDeliveryJobs.id, id));
      if (
        !job ||
        job.userId !== envelope.userId ||
        job.operationId !== envelope.operationId ||
        job.scopeKey !== envelope.scopeKey ||
        job.intentHash !== envelope.intentHash
      ) {
        throw new BotDeliveryConflict('payload_conflict');
      }
      // First payload wins, including its rendered-time statistics. Never reset a tombstone.
      return { id: job.id, status: job.status };
    });
  }

  async recoverExpiredJobs(): Promise<number> {
    return this.transaction(async (tx) => {
      const expired = await tx
        .select({ id: botDeliveryJobs.id })
        .from(botDeliveryJobs)
        .where(and(eq(botDeliveryJobs.status, 'running'), lte(botDeliveryJobs.leaseExpiresAt, now)))
        .orderBy(asc(botDeliveryJobs.leaseExpiresAt))
        .limit(100)
        .for('update', { skipLocked: true });
      if (!expired.length) return 0;
      await tx
        .update(botDeliveryJobs)
        .set({
          errorCode: 'worker_lease_expired',
          leaseExpiresAt: null,
          leaseOwner: null,
          nextAttemptAt: sql`clock_timestamp() + least(3600, 5 * power(2, least(${botDeliveryJobs.attempts}, 10))) * interval '1 second'`,
          status: sql`case when ${botDeliveryJobs.attempts} >= ${DELIVERY_MAX_ATTEMPTS} then 'dead' else 'pending' end`,
          updatedAt: now,
        })
        .where(
          inArray(
            botDeliveryJobs.id,
            expired.map((row) => row.id),
          ),
        );
      return expired.length;
    });
  }

  async claim(role: 'inbox' | 'outbox'): Promise<BotDeliveryJob | null> {
    return this.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(botDeliveryJobs)
        .where(
          and(
            eq(botDeliveryJobs.role, role),
            eq(botDeliveryJobs.status, 'pending'),
            lte(botDeliveryJobs.nextAttemptAt, now),
          ),
        )
        .orderBy(
          desc(botDeliveryJobs.priority),
          asc(botDeliveryJobs.nextAttemptAt),
          asc(botDeliveryJobs.id),
        )
        .limit(1)
        .for('update', { skipLocked: true });
      if (!candidate) return null;
      const [claimed] = await tx
        .update(botDeliveryJobs)
        .set({
          attempts: candidate.attempts + 1,
          leaseExpiresAt: jobLeaseUntil,
          leaseOwner: randomUUID(),
          status: 'running',
          updatedAt: now,
        })
        .where(eq(botDeliveryJobs.id, candidate.id))
        .returning();
      return claimed;
    });
  }

  async renewJob(lease: DeliveryJobLease): Promise<boolean> {
    const rows = await this.db
      .update(botDeliveryJobs)
      .set({ leaseExpiresAt: jobLeaseUntil, updatedAt: now })
      .where(jobFence(lease))
      .returning({ id: botDeliveryJobs.id });
    return rows.length === 1;
  }

  /** Atomic local transport: durable outbox -> durable inbox, no unsigned HTTP fallback. */
  async transfer(job: BotDeliveryJob): Promise<boolean> {
    return this.transaction(async (tx) => {
      const [owned] = await tx
        .select()
        .from(botDeliveryJobs)
        .where(jobFence({ id: job.id, owner: job.leaseOwner! }))
        .for('update');
      if (!owned || !owned.payload || owned.role !== 'outbox') return false;
      const id = `inbox:${owned.eventKey}`;
      await tx
        .insert(botDeliveryJobs)
        .values({
          eventKey: owned.eventKey,
          id,
          intentHash: owned.intentHash,
          operationId: owned.operationId,
          payload: owned.payload,
          priority: owned.priority,
          role: 'inbox',
          scopeKey: owned.scopeKey,
          userId: owned.userId,
        })
        .onConflictDoNothing();
      const [inbox] = await tx.select().from(botDeliveryJobs).where(eq(botDeliveryJobs.id, id));
      if (
        !inbox ||
        inbox.intentHash !== owned.intentHash ||
        inbox.userId !== owned.userId ||
        inbox.scopeKey !== owned.scopeKey
      ) {
        throw new BotDeliveryConflict('payload_conflict');
      }
      await tx
        .update(botDeliveryJobs)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          payload: null,
          deliveredAt: inbox.status === 'delivered' ? now : null,
          status: inbox.status === 'delivered' ? 'delivered' : 'transferred',
          updatedAt: now,
        })
        .where(eq(botDeliveryJobs.id, owned.id));
      return true;
    });
  }

  async delivered(job: BotDeliveryJob): Promise<boolean> {
    return this.transaction(async (tx) => {
      const rows = await tx
        .update(botDeliveryJobs)
        .set({
          deliveredAt: now,
          errorCode: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          payload: null,
          status: 'delivered',
          updatedAt: now,
        })
        .where(jobFence({ id: job.id, owner: job.leaseOwner! }))
        .returning({ id: botDeliveryJobs.id });
      if (!rows.length) return false;
      await tx
        .update(botDeliveryJobs)
        .set({ deliveredAt: now, payload: null, status: 'delivered', updatedAt: now })
        .where(
          and(
            eq(botDeliveryJobs.id, `outbox:${job.eventKey}`),
            eq(botDeliveryJobs.userId, job.userId),
            eq(botDeliveryJobs.status, 'transferred'),
          ),
        );
      return true;
    });
  }

  async failed(job: BotDeliveryJob, code: string, uncertain: boolean): Promise<void> {
    const yielded = code === 'budget_exhausted';
    const status = uncertain
      ? 'unknown'
      : !yielded && job.attempts >= DELIVERY_MAX_ATTEMPTS
        ? 'dead'
        : 'pending';
    const seconds =
      Math.min(3600, 5 * 2 ** Math.min(job.attempts, 10)) + Math.floor(Math.random() * 5);
    await this.db
      .update(botDeliveryJobs)
      .set({
        attempts: yielded ? Math.max(0, job.attempts - 1) : job.attempts,
        errorCode: yielded ? null : code,
        leaseExpiresAt: null,
        leaseOwner: null,
        nextAttemptAt: sql`clock_timestamp() + ${yielded ? 1 : seconds} * interval '1 second'`,
        status,
        updatedAt: now,
      })
      .where(jobFence({ id: job.id, owner: job.leaseOwner! }));
  }

  async importLedger(userId: string, scopeKey: string, state: BotDeliveryLedgerState) {
    return this.transaction(async (tx) => {
      const inserted = await tx
        .insert(botDeliveryLedgers)
        .values({ scopeKey, state, userId })
        .onConflictDoNothing()
        .returning({ scopeKey: botDeliveryLedgers.scopeKey });
      if (inserted.length)
        await tx.insert(botDeliveryAudits).values({
          action: 'import_legacy',
          actorId: userId,
          evidence: 'Owner-free legacy Redis snapshot',
          id: randomUUID(),
          note: 'Imported legacy callback ledger without replaying messages',
          scopeKey,
          userId,
        });
    });
  }

  async getLedger(userId: string, scopeKey: string) {
    const [row] = await this.db
      .select()
      .from(botDeliveryLedgers)
      .where(and(eq(botDeliveryLedgers.scopeKey, scopeKey), eq(botDeliveryLedgers.userId, userId)));
    return row ?? null;
  }

  private ledgerFence(userId: string, scopeKey: string, owner: string, job?: DeliveryJobLease) {
    return and(
      eq(botDeliveryLedgers.scopeKey, scopeKey),
      eq(botDeliveryLedgers.userId, userId),
      eq(botDeliveryLedgers.leaseOwner, owner),
      sql`${botDeliveryLedgers.leaseExpiresAt} > clock_timestamp()`,
      job ? sql`exists(select 1 from ${botDeliveryJobs} where ${jobFence(job)})` : undefined,
    );
  }

  async acquireLedger(
    userId: string,
    scopeKey: string,
    owner: string,
    seed: BotDeliveryLedgerState,
    job?: DeliveryJobLease,
  ) {
    return this.transaction(async (tx) => {
      await tx
        .insert(botDeliveryLedgers)
        .values({ scopeKey, state: seed, userId })
        .onConflictDoNothing();
      const [row] = await tx
        .update(botDeliveryLedgers)
        .set({ leaseExpiresAt: ledgerLeaseUntil, leaseOwner: owner, updatedAt: now })
        .where(
          and(
            eq(botDeliveryLedgers.scopeKey, scopeKey),
            eq(botDeliveryLedgers.userId, userId),
            freeLedger,
            job ? sql`exists(select 1 from ${botDeliveryJobs} where ${jobFence(job)})` : undefined,
          ),
        )
        .returning({ state: botDeliveryLedgers.state });
      return row?.state ?? null;
    });
  }

  async saveLedger(
    userId: string,
    scopeKey: string,
    owner: string,
    state: BotDeliveryLedgerState,
    job?: DeliveryJobLease,
  ) {
    const rows = await this.db
      .update(botDeliveryLedgers)
      .set({
        leaseExpiresAt: ledgerLeaseUntil,
        revision: sql`${botDeliveryLedgers.revision} + 1`,
        state,
        updatedAt: now,
      })
      .where(this.ledgerFence(userId, scopeKey, owner, job))
      .returning({ scopeKey: botDeliveryLedgers.scopeKey });
    return rows.length === 1;
  }

  async renewLedger(userId: string, scopeKey: string, owner: string, job?: DeliveryJobLease) {
    const rows = await this.db
      .update(botDeliveryLedgers)
      .set({ leaseExpiresAt: ledgerLeaseUntil, updatedAt: now })
      .where(this.ledgerFence(userId, scopeKey, owner, job))
      .returning({ scopeKey: botDeliveryLedgers.scopeKey });
    return rows.length === 1;
  }

  async releaseLedger(userId: string, scopeKey: string, owner: string) {
    await this.db
      .update(botDeliveryLedgers)
      .set({ leaseExpiresAt: null, leaseOwner: null })
      .where(
        and(
          eq(botDeliveryLedgers.scopeKey, scopeKey),
          eq(botDeliveryLedgers.userId, userId),
          eq(botDeliveryLedgers.leaseOwner, owner),
        ),
      );
  }

  async list(
    userId: string,
    before?: { createdAt: string; id: string },
    limit = 30,
    status?: BotDeliveryJob['status'],
  ) {
    const rows = await this.db
      .select({
        attempts: botDeliveryJobs.attempts,
        createdAt: botDeliveryJobs.createdAt,
        errorCode: botDeliveryJobs.errorCode,
        id: botDeliveryJobs.id,
        nextAttemptAt: botDeliveryJobs.nextAttemptAt,
        operationId: botDeliveryJobs.operationId,
        role: botDeliveryJobs.role,
        scopeKey: botDeliveryJobs.scopeKey,
        status: botDeliveryJobs.status,
      })
      .from(botDeliveryJobs)
      .where(
        and(
          eq(botDeliveryJobs.userId, userId),
          status ? eq(botDeliveryJobs.status, status) : undefined,
          before
            ? or(
                sql`${botDeliveryJobs.createdAt} < ${new Date(before.createdAt)}`,
                and(
                  eq(botDeliveryJobs.createdAt, new Date(before.createdAt)),
                  sql`${botDeliveryJobs.id} < ${before.id}`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(botDeliveryJobs.createdAt), desc(botDeliveryJobs.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null,
    };
  }

  async inspect(userId: string, scopeKey: string) {
    const ledger = await this.getLedger(userId, scopeKey);
    const jobs = await this.db
      .select({
        attempts: botDeliveryJobs.attempts,
        errorCode: botDeliveryJobs.errorCode,
        id: botDeliveryJobs.id,
        operationId: botDeliveryJobs.operationId,
        role: botDeliveryJobs.role,
        status: botDeliveryJobs.status,
      })
      .from(botDeliveryJobs)
      .where(and(eq(botDeliveryJobs.userId, userId), eq(botDeliveryJobs.scopeKey, scopeKey)))
      .limit(100);
    const audits = await this.db
      .select()
      .from(botDeliveryAudits)
      .where(and(eq(botDeliveryAudits.userId, userId), eq(botDeliveryAudits.scopeKey, scopeKey)))
      .orderBy(desc(botDeliveryAudits.createdAt))
      .limit(50);
    const [destination] = await this.db
      .select({
        applicationId: sql<string | null>`${botDeliveryJobs.payload}::json->>'applicationId'`.as(
          'application_id',
        ),
        messengerInstallationKey: sql<
          string | null
        >`${botDeliveryJobs.payload}::json->>'messengerInstallationKey'`.as(
          'messenger_installation_key',
        ),
        platformThreadId: sql<
          string | null
        >`${botDeliveryJobs.payload}::json->>'platformThreadId'`.as('platform_thread_id'),
      })
      .from(botDeliveryJobs)
      .where(
        and(
          eq(botDeliveryJobs.userId, userId),
          eq(botDeliveryJobs.scopeKey, scopeKey),
          isNotNull(botDeliveryJobs.payload),
        ),
      )
      .orderBy(desc(botDeliveryJobs.priority))
      .limit(1);
    const visibleLedger = ledger ? (({ leaseOwner: _owner, ...visible }) => visible)(ledger) : null;
    return { audits, destination: destination ?? null, jobs, ledger: visibleLedger };
  }

  async reconcile(
    userId: string,
    input: {
      effectId: string;
      evidence: string;
      expectedRevision: number;
      note: string;
      resolution: 'confirmed_delivered' | 'confirmed_not_delivered';
      scopeKey: string;
    },
  ) {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(botDeliveryLedgers)
        .where(
          and(
            eq(botDeliveryLedgers.scopeKey, input.scopeKey),
            eq(botDeliveryLedgers.userId, userId),
            eq(botDeliveryLedgers.revision, input.expectedRevision),
            freeLedger,
            sql`${botDeliveryLedgers.updatedAt} < clock_timestamp() - interval '60 seconds'`,
          ),
        )
        .for('update');
      if (!row || row.state.effects[input.effectId] !== 'unknown_delivery')
        throw new BotDeliveryConflict('reconciliation_conflict');
      const [active] = await tx
        .select({ id: botDeliveryJobs.id })
        .from(botDeliveryJobs)
        .where(
          and(
            eq(botDeliveryJobs.scopeKey, input.scopeKey),
            eq(botDeliveryJobs.userId, userId),
            eq(botDeliveryJobs.status, 'running'),
            sql`${botDeliveryJobs.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (active) throw new BotDeliveryConflict('delivery_active');
      const state = structuredClone(row.state);
      if (input.resolution === 'confirmed_delivered') state.effects[input.effectId] = 'delivered';
      else delete state.effects[input.effectId];
      const revision = row.revision + 1;
      await tx
        .update(botDeliveryLedgers)
        .set({ leaseExpiresAt: null, leaseOwner: null, revision, state, updatedAt: now })
        .where(eq(botDeliveryLedgers.scopeKey, row.scopeKey));
      await tx.insert(botDeliveryAudits).values({
        action: input.resolution,
        actorId: userId,
        afterRevision: revision,
        beforeRevision: row.revision,
        effectId: input.effectId,
        evidence: input.evidence,
        id: randomUUID(),
        note: input.note,
        scopeKey: row.scopeKey,
        userId,
      });
      // Only jobs held for ambiguous platform delivery are released. Payload conflicts need investigation.
      await tx
        .update(botDeliveryJobs)
        .set({
          attempts: 0,
          errorCode: null,
          nextAttemptAt: now,
          status: 'pending',
          updatedAt: now,
        })
        .where(
          and(
            eq(botDeliveryJobs.scopeKey, row.scopeKey),
            eq(botDeliveryJobs.userId, userId),
            eq(botDeliveryJobs.status, 'unknown'),
            eq(botDeliveryJobs.errorCode, 'unknown_delivery'),
          ),
        );
      return { revision };
    });
  }

  async retryDead(userId: string, input: { evidence: string; jobId: string; note: string }) {
    return this.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(botDeliveryJobs)
        .where(
          and(
            eq(botDeliveryJobs.id, input.jobId),
            eq(botDeliveryJobs.userId, userId),
            eq(botDeliveryJobs.status, 'dead'),
          ),
        )
        .for('update');
      if (!job || !job.payload) throw new BotDeliveryConflict('job_not_retryable');
      await tx
        .update(botDeliveryJobs)
        .set({
          attempts: 0,
          errorCode: null,
          nextAttemptAt: now,
          status: 'pending',
          updatedAt: now,
        })
        .where(eq(botDeliveryJobs.id, job.id));
      await tx.insert(botDeliveryAudits).values({
        action: 'retry_dead',
        actorId: userId,
        evidence: input.evidence,
        id: randomUUID(),
        jobId: job.id,
        note: input.note,
        scopeKey: job.scopeKey,
        userId,
      });
      return { id: job.id };
    });
  }
}

export type { BotDeliveryJob } from '../schemas/botDelivery';
