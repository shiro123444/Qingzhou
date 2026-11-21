import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import { agents } from '@/database/schemas/agent';
import {
  agentComputerCommands as commands,
  agentComputerSessions as sessions,
} from '@/database/schemas/agentComputer';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  ComputerActor,
  ComputerCommand,
  ComputerReceipt,
  ComputerScope,
  ComputerView,
} from '@/types/agentComputer';

import { ComputerError, digest } from './provider';

export interface ComputerLease {
  commandId: string;
  control: ComputerActor;
  expiresAt: string;
  owner: string;
  resourceId?: string;
  revision: number;
  sessionId: string;
}
type Session = typeof sessions.$inferSelect;
const now = sql`clock_timestamp()`;

export class ComputerStore {
  constructor(
    private readonly db: LobeChatDatabase,
    readonly scope: ComputerScope,
    private readonly binding: string,
  ) {
    if (!scope.userId || !scope.agentId) throw new ComputerError('NOT_FOUND');
  }
  async assertOwner() {
    const [owned] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, this.scope.agentId), eq(agents.userId, this.scope.userId)));
    if (!owned) throw new ComputerError('NOT_FOUND');
  }
  private where() {
    return and(eq(sessions.userId, this.scope.userId), eq(sessions.agentId, this.scope.agentId));
  }
  private async transaction<T>(run: (tx: Transaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5000ms'`);
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      return run(tx);
    });
  }
  private async recover(tx: Transaction, row: Session) {
    if (!row.leaseOwner) return row;
    const [clock] = await tx
      .select({
        expired: sql<boolean>`coalesce(${row.leaseUntil}::timestamptz <= clock_timestamp(), true)`,
      })
      .from(sessions)
      .where(eq(sessions.id, row.id));
    if (!clock?.expired) return row;
    const [command] = await tx
      .select()
      .from(commands)
      .where(and(eq(commands.id, row.leaseCommandId!), eq(commands.sessionId, row.id)))
      .for('update');
    const uncertain = command?.status !== 'prepared';
    if (command)
      await tx
        .update(commands)
        .set({ status: uncertain ? 'unknown' : 'cancelled', completedAt: now })
        .where(eq(commands.id, command.id));
    const [recovered] = await tx
      .update(sessions)
      .set({
        state: uncertain ? 'unknown' : row.state,
        leaseOwner: null,
        leaseUntil: null,
        leaseCommandId: null,
      })
      .where(eq(sessions.id, row.id))
      .returning();
    return recovered;
  }
  async claim(
    command: ComputerCommand,
    actor: ComputerActor,
    requestId: string,
    expectedRevision?: number,
  ): Promise<{ cached: ComputerReceipt } | { lease: ComputerLease }> {
    await this.assertOwner();
    await this.recoverExpired();
    const requestKey = digest([actor, requestId]);
    const inputHash = digest([actor, command]);
    return this.transaction(async (tx) => {
      // Serialize initial creation without allocating a provider resource inside the transaction.
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, this.scope.agentId), eq(agents.userId, this.scope.userId)))
        .for('update');
      if (!agent) throw new ComputerError('NOT_FOUND');
      await tx
        .insert(sessions)
        .values({ id: randomUUID(), ...this.scope, providerBinding: this.binding })
        .onConflictDoNothing();
      const [row] = await tx.select().from(sessions).where(this.where()).for('update');
      if (row.providerBinding !== this.binding) throw new ComputerError('PROVIDER_CHANGED');
      const [existing] = await tx
        .select()
        .from(commands)
        .where(and(eq(commands.sessionId, row.id), eq(commands.requestKey, requestKey)));
      if (existing) {
        if (existing.inputHash !== inputHash) throw new ComputerError('REQUEST_CONFLICT');
        if (existing.status === 'done' && existing.receipt) return { cached: existing.receipt };
        throw new ComputerError(
          existing.status === 'unknown'
            ? 'OUTCOME_UNKNOWN'
            : existing.status === 'cancelled'
              ? 'CANCELLED'
              : 'BUSY',
        );
      }
      if (row.state === 'unknown') throw new ComputerError('OUTCOME_UNKNOWN');
      if (row.leaseOwner) throw new ComputerError('BUSY');
      if (expectedRevision !== undefined && row.revision !== expectedRevision)
        throw new ComputerError('STALE');
      if (actor === 'agent' && (row.control !== 'agent' || command.kind === 'control'))
        throw new ComputerError('CONTROL_DENIED');
      if (
        ['shell', 'browser'].includes(command.kind) &&
        (row.control !== actor || row.state !== 'ready')
      )
        throw new ComputerError('CONTROL_DENIED');
      if (command.kind !== 'ensure' && !row.resourceId) throw new ComputerError('CONTROL_DENIED');
      if (command.kind === 'control' && row.state !== 'ready')
        throw new ComputerError('CONTROL_DENIED');
      if (command.kind === 'sleep' && row.state !== 'ready')
        throw new ComputerError('CONTROL_DENIED');
      const owner = randomUUID(),
        commandId = randomUUID(),
        revision = row.revision + 1;
      await tx.insert(commands).values({
        id: commandId,
        sessionId: row.id,
        userId: this.scope.userId,
        requestKey,
        inputHash,
        actor,
        kind: command.kind,
        revision,
        expectedState: command.kind === 'sleep' ? 'sleeping' : 'ready',
        expectedControl: command.kind === 'control' ? command.target : row.control,
      });
      const [accepted] = await tx
        .update(sessions)
        .set({
          revision,
          leaseOwner: owner,
          leaseCommandId: commandId,
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .where(eq(sessions.id, row.id))
        .returning();
      return {
        lease: {
          sessionId: row.id,
          commandId,
          owner,
          revision,
          expiresAt: accepted.leaseUntil!.toISOString(),
          resourceId: row.resourceId ?? undefined,
          control: row.control,
        },
      };
    });
  }
  async recoverExpired() {
    await this.transaction(async (tx) => {
      const [row] = await tx.select().from(sessions).where(this.where()).for('update');
      if (row) await this.recover(tx, row);
    });
  }
  async consoleIdentity(expectedRevision: number) {
    await this.assertOwner();
    const [session] = await this.db.select().from(sessions).where(this.where());
    if (!session) throw new ComputerError('NOT_FOUND');
    if (session.providerBinding !== this.binding) throw new ComputerError('PROVIDER_CHANGED');
    if (session.revision !== expectedRevision) throw new ComputerError('STALE');
    if (session.state !== 'ready' || session.leaseOwner || !session.resourceId)
      throw new ComputerError('BUSY');
    return { sessionId: session.id, resourceId: session.resourceId, revision: session.revision };
  }
  private fence(lease: ComputerLease) {
    return and(
      this.where(),
      eq(sessions.id, lease.sessionId),
      eq(sessions.leaseOwner, lease.owner),
      eq(sessions.leaseCommandId, lease.commandId),
      eq(sessions.revision, lease.revision),
      sql`${sessions.leaseUntil} > clock_timestamp()`,
    );
  }
  async dispatch(lease: ComputerLease) {
    return this.transaction(async (tx) => {
      const [held] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(this.fence(lease))
        .for('update');
      if (!held) throw new ComputerError('OUTCOME_UNKNOWN');
      const [written] = await tx
        .update(commands)
        .set({ status: 'dispatched' })
        .where(
          and(
            eq(commands.id, lease.commandId),
            eq(commands.sessionId, held.id),
            eq(commands.status, 'prepared'),
          ),
        )
        .returning({ id: commands.id });
      if (!written) throw new ComputerError('OUTCOME_UNKNOWN');
    });
  }
  async finish(lease: ComputerLease, receipt: ComputerReceipt) {
    return this.transaction(async (tx) => {
      const [held] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(this.fence(lease))
        .for('update');
      if (!held) throw new ComputerError('OUTCOME_UNKNOWN');
      const [written] = await tx
        .update(commands)
        .set({ status: 'done', receipt, completedAt: now })
        .where(
          and(
            eq(commands.id, lease.commandId),
            eq(commands.sessionId, held.id),
            eq(commands.status, 'dispatched'),
          ),
        )
        .returning({ id: commands.id });
      if (!written) throw new ComputerError('OUTCOME_UNKNOWN');
      const [committed] = await tx
        .update(sessions)
        .set({
          resourceId: receipt.resourceId,
          state: receipt.state,
          control: receipt.control,
          leaseOwner: null,
          leaseUntil: null,
          leaseCommandId: null,
        })
        .where(this.fence(lease))
        .returning({ id: sessions.id });
      if (!committed) throw new ComputerError('OUTCOME_UNKNOWN');
    });
  }
  async fail(lease: ComputerLease) {
    await this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessions)
        .where(
          and(
            this.where(),
            eq(sessions.id, lease.sessionId),
            eq(sessions.leaseOwner, lease.owner),
            eq(sessions.revision, lease.revision),
          ),
        )
        .for('update');
      if (!row) return;
      const [command] = await tx
        .select()
        .from(commands)
        .where(and(eq(commands.id, lease.commandId), eq(commands.sessionId, row.id)))
        .for('update');
      const uncertain = command?.status !== 'prepared';
      if (command)
        await tx
          .update(commands)
          .set({ status: uncertain ? 'unknown' : 'cancelled', completedAt: now })
          .where(eq(commands.id, command.id));
      await tx
        .update(sessions)
        .set({
          state: uncertain ? 'unknown' : row.state,
          leaseOwner: null,
          leaseUntil: null,
          leaseCommandId: null,
        })
        .where(eq(sessions.id, row.id));
    });
  }
  async view(): Promise<Omit<ComputerView, 'enabled'>> {
    await this.assertOwner();
    const [row] = await this.db
      .select({
        id: sessions.id,
        providerBinding: sessions.providerBinding,
        state: sessions.state,
        control: sessions.control,
        revision: sessions.revision,
        updatedAt: sessions.updatedAt,
        leaseOwner: sessions.leaseOwner,
        expired: sql<boolean>`coalesce(${sessions.leaseUntil} <= clock_timestamp(), false)`,
      })
      .from(sessions)
      .where(this.where());
    if (!row) return { commands: [] };
    const recent = await this.db
      .select({
        id: commands.id,
        kind: commands.kind,
        actor: commands.actor,
        status: commands.status,
        exitCode: sql<number | null>`${commands.receipt}->'exitCode'`,
        createdAt: commands.createdAt,
        completedAt: commands.completedAt,
      })
      .from(commands)
      .where(and(eq(commands.sessionId, row.id), eq(commands.userId, this.scope.userId)))
      .orderBy(desc(commands.createdAt), desc(commands.id))
      .limit(10);
    return {
      bindingChanged: row.providerBinding !== this.binding,
      session: {
        id: row.id,
        state: row.leaseOwner && row.expired ? 'unknown' : row.state,
        control: row.control,
        revision: row.revision,
        busy: !!row.leaseOwner && !row.expired,
        updatedAt: row.updatedAt.toISOString(),
      },
      commands: recent.map(({ exitCode, createdAt, completedAt, ...command }) => ({
        ...command,
        exitCode: exitCode ?? undefined,
        createdAt: createdAt.toISOString(),
        completedAt: completedAt?.toISOString(),
      })),
    };
  }
  async receiptIdentity(commandId: string) {
    await this.assertOwner();
    await this.recoverExpired();
    const [session] = await this.db.select().from(sessions).where(this.where());
    if (!session || session.providerBinding !== this.binding)
      throw new ComputerError('PROVIDER_CHANGED');
    const [command] = await this.db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.id, commandId),
          eq(commands.sessionId, session.id),
          eq(commands.userId, this.scope.userId),
        ),
      );
    if (!command) throw new ComputerError('NOT_FOUND');
    if (
      session.leaseOwner ||
      session.revision !== command.revision ||
      command.status !== 'unknown' ||
      !command.expectedState ||
      !command.expectedControl
    )
      throw new ComputerError('STALE');
    return { sessionId: session.id, commandId: command.id, revision: command.revision };
  }
  async reconcile(commandId: string, revision: number, receipt: ComputerReceipt) {
    return this.transaction(async (tx) => {
      const [session] = await tx.select().from(sessions).where(this.where()).for('update');
      if (
        !session ||
        session.providerBinding !== this.binding ||
        session.revision !== revision ||
        session.leaseOwner ||
        session.state !== 'unknown'
      )
        throw new ComputerError('STALE');
      const [command] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.id, commandId),
            eq(commands.sessionId, session.id),
            eq(commands.userId, this.scope.userId),
          ),
        )
        .for('update');
      if (
        !command ||
        command.status !== 'unknown' ||
        command.revision !== revision ||
        !command.expectedState ||
        !command.expectedControl ||
        command.expectedState !== receipt.state ||
        command.expectedControl !== receipt.control ||
        (session.resourceId && session.resourceId !== receipt.resourceId) ||
        (command.kind === 'shell' && receipt.exitCode === undefined)
      )
        throw new ComputerError('INVALID_RESPONSE');
      await tx
        .update(commands)
        .set({ status: 'done', receipt, completedAt: now })
        .where(eq(commands.id, command.id));
      await tx
        .update(sessions)
        .set({ state: receipt.state, control: receipt.control, resourceId: receipt.resourceId })
        .where(eq(sessions.id, session.id));
    });
  }
}
