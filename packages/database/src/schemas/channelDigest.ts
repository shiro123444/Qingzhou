import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamptz } from './_helpers';
import { agentBotProviders } from './agentBotProvider';
import { users } from './user';

export const channelDigestRules = pgTable(
  'channel_digest_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => agentBotProviders.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    sendToSource: boolean('send_to_source').notNull().default(false),
    scheduleTime: text('schedule_time').notNull().default('18:00'),
    revision: uuid('revision').notNull().defaultRandom(),
    cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
    nextRunAt: timestamptz('next_run_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channel_digest_rule_scope_idx').on(t.providerId, t.threadId),
    index('channel_digest_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.enabled} = true`),
    check('channel_digest_time_check', sql`${t.scheduleTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  ],
);

export const channelDigestMessages = pgTable(
  'channel_digest_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => channelDigestRules.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    senderId: text('sender_id').notNull(),
    content: text('content').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('channel_digest_message_event_idx').on(t.ruleId, t.eventId),
    index('channel_digest_message_cursor_idx').on(t.ruleId, t.id),
    index('channel_digest_message_expiry_idx').on(t.expiresAt),
  ],
);

export const channelDigestRuns = pgTable(
  'channel_digest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => channelDigestRules.id, { onDelete: 'cascade' }),
    revision: uuid('revision').notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'empty', 'failed', 'unknown', 'cancelled'],
    }).notNull(),
    scheduledFor: timestamptz('scheduled_for').notNull(),
    leaseExpiresAt: timestamptz('lease_expires_at').notNull(),
    lastMessageId: bigint('last_message_id', { mode: 'number' }).notNull().default(0),
    messageCount: integer('message_count').notNull().default(0),
    hasMore: boolean('has_more').notNull().default(false),
    truncated: boolean('truncated').notNull().default(false),
    content: text('content'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channel_digest_run_schedule_idx').on(t.ruleId, t.scheduledFor),
    index('channel_digest_run_expiry_idx').on(t.createdAt),
    check(
      'channel_digest_run_status_check',
      sql`${t.status} in ('running','completed','empty','failed','unknown','cancelled')`,
    ),
  ],
);

export type ChannelDigestRule = typeof channelDigestRules.$inferSelect;
export type ChannelDigestRun = typeof channelDigestRuns.$inferSelect;
export type ChannelDigestMessage = typeof channelDigestMessages.$inferSelect;
