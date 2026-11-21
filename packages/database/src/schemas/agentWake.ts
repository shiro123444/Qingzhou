import { index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

import { timestamps, timestamptz } from './_helpers';
import { users } from './user';

export const agentWakeJobs = pgTable(
  'agent_wake_jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    payload: jsonb('payload').$type<Record<string, any>>().notNull(),
    intentHash: text('intent_hash').notNull(),
    status: text('status', {
      enum: ['queued', 'claimed', 'dispatched', 'done', 'unknown', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamptz('lease_until'),
    attempts: integer('attempts').notNull().default(0),
    receipt: jsonb('receipt').$type<Record<string, any>>(),
    errorCode: text('error_code'),
    ...timestamps,
  },
  (t) => [
    index('agent_wake_ready_idx').on(t.status, t.availableAt),
    index('agent_wake_lease_idx').on(t.status, t.leaseUntil),
    index('agent_wake_scope_idx').on(t.scopeKey, t.status),
    index('agent_wake_owner_idx').on(t.userId),
  ],
);
export type AgentWakeJob = typeof agentWakeJobs.$inferSelect;
