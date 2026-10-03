import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from './_helpers';
import { users } from './user';

export const botInboundEvents = pgTable(
  'bot_inbound_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    applicationId: text('application_id').notNull(),
    threadId: text('thread_id').notNull(),
    eventId: text('event_id').notNull(),
    payload: text('payload'),
    payloadHash: text('payload_hash').notNull(),
    isControl: boolean('is_control').notNull().default(false),
    status: text('status', { enum: ['pending', 'running', 'processed', 'unknown', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamptz('lease_expires_at'),
    dispatchStartedAt: timestamptz('dispatch_started_at'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('bot_inbound_ready_idx').on(t.status, t.nextAttemptAt, t.createdAt, t.id),
    index('bot_inbound_owner_idx').on(t.userId, t.createdAt),
    index('bot_inbound_thread_idx').on(t.userId, t.platform, t.applicationId, t.threadId),
    check(
      'bot_inbound_status_check',
      sql`${t.status} in ('pending','running','processed','unknown','dead')`,
    ),
  ],
);

// A group uses one shared conversation per owning account + installation + thread.
// Platform sender authorization continues to be enforced by the message router.
export const botExecutionSessions = pgTable('bot_execution_sessions', {
  scopeKey: text('scope_key').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(),
  operationId: text('operation_id'),
  stopRequested: integer('stop_requested').notNull().default(0),
  leaseExpiresAt: timestamptz('lease_expires_at').notNull(),
  updatedAt: updatedAt(),
});

export const botPollingCursors = pgTable('bot_polling_cursors', {
  scopeKey: text('scope_key').primaryKey(),
  cursor: text('cursor').notNull(),
  updatedAt: updatedAt(),
});

export type BotInboundEvent = typeof botInboundEvents.$inferSelect;
