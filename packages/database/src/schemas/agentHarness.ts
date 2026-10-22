import { index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from './_helpers';
import { agents } from './agent';
import { users } from './user';

/** Short-lived publication transactions are independent of experiment execution leases. */
export const agentHarnessHeads = pgTable(
  'agent_harness_heads',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(0),
    decisionId: text('decision_id'),
    cancelledExperiments: jsonb('cancelled_experiments').$type<string[]>().notNull().default([]),
    sourceRevisionId: text('source_revision_id'),
    activeRevisionId: text('active_revision_id'),
    sourceRevision: jsonb('source_revision').$type<Record<string, unknown>>(),
    activeRevision: jsonb('active_revision').$type<Record<string, unknown>>(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agentId] })],
);

/** Decision, immutable evidence bundle and outbox are committed with the publication head. */
export const agentHarnessDecisions = pgTable(
  'agent_harness_decisions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    commandHash: text('command_hash').notNull(),
    decision: jsonb('decision').$type<Record<string, unknown>>().notNull(),
    proof: jsonb('proof').$type<Record<string, unknown>>(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    deliveredAt: timestamptz('delivered_at'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    deliveryError: text('delivery_error'),
    leaseToken: text('lease_token'),
    leaseUntil: timestamptz('lease_until'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.agentId, t.requestId] }),
    index('agent_harness_outbox_idx').on(t.deliveredAt, t.leaseUntil),
  ],
);
