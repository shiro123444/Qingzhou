import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from './_helpers';
import { users } from './user';

export interface BotDeliveryLedgerState {
  completionStarted?: boolean;
  effects: Record<string, 'delivered' | 'unknown_delivery'>;
  events: Record<
    string,
    { delivered?: boolean; fingerprint: string; plan?: string; renderedPlan?: unknown }
  >;
  highestStep?: number;
}

export const botDeliveryJobs = pgTable(
  'bot_delivery_jobs',
  {
    id: text('id').primaryKey(),
    role: text('role', { enum: ['outbox', 'inbox'] }).notNull(),
    eventKey: text('event_key').notNull(),
    scopeKey: text('scope_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    // JSON wire text avoids object-key reordering by database/proxy JSON codecs.
    payload: text('payload'),
    intentHash: text('intent_hash').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'transferred', 'delivered', 'unknown', 'dead'],
    })
      .notNull()
      .default('pending'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamptz('lease_expires_at'),
    errorCode: text('error_code'),
    deliveredAt: timestamptz('delivered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('bot_delivery_event_role_unique').on(table.role, table.eventKey),
    index('bot_delivery_ready_idx')
      .on(table.role, table.priority.desc(), table.nextAttemptAt, table.id)
      .where(sql`${table.status} in ('pending', 'running')`),
    index('bot_delivery_owner_idx').on(table.userId, table.createdAt, table.id),
    index('bot_delivery_scope_idx').on(table.scopeKey),
    index('bot_delivery_expired_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'running'`),
    check('bot_delivery_role_check', sql`${table.role} in ('outbox', 'inbox')`),
    check(
      'bot_delivery_payload_check',
      sql`${table.payload} is null or json_typeof(${table.payload}::json) = 'object'`,
    ),
    check(
      'bot_delivery_status_check',
      sql`${table.status} in ('pending', 'running', 'transferred', 'delivered', 'unknown', 'dead')`,
    ),
  ],
);

// Deliberately separate the event queue from operation-scoped message effects.
// A queue lease expiring must never erase a platform send's unknown outcome.
export const botDeliveryLedgers = pgTable(
  'bot_delivery_ledgers',
  {
    scopeKey: text('scope_key').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: jsonb('state').$type<BotDeliveryLedgerState>().notNull(),
    revision: integer('revision').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamptz('lease_expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('bot_delivery_ledger_owner_idx').on(table.userId)],
);

export const botDeliveryAudits = pgTable(
  'bot_delivery_audits',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    jobId: text('job_id'),
    effectId: text('effect_id'),
    action: text('action', {
      enum: ['confirmed_delivered', 'confirmed_not_delivered', 'retry_dead', 'import_legacy'],
    }).notNull(),
    note: text('note').notNull(),
    evidence: text('evidence').notNull(),
    beforeRevision: integer('before_revision'),
    afterRevision: integer('after_revision'),
    createdAt: createdAt(),
  },
  (table) => [index('bot_delivery_audit_owner_idx').on(table.userId, table.createdAt)],
);

export type BotDeliveryJob = typeof botDeliveryJobs.$inferSelect;
