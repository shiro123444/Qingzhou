import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { timestamps, timestamptz } from './_helpers';
import { users } from './user';

/** Authoritative native execution state; waiting for a human has no short cache TTL. */
export const agentRuntimeCheckpoints = pgTable(
  'agent_runtime_checkpoints',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: jsonb('state').$type<Record<string, any>>(),
    metadata: jsonb('metadata').$type<Record<string, any>>().notNull(),
    history: jsonb('history').$type<Record<string, any>[]>().notNull().default([]),
    leaseOwner: text('lease_owner'),
    leaseStep: integer('lease_step'),
    leaseUntil: timestamptz('lease_until'),
    ...timestamps,
  },
  (table) => [index('agent_runtime_checkpoint_owner_idx').on(table.userId)],
);

/** Dispatch is recorded before execution. An expired dispatch is never blindly replayed. */
export const agentRuntimeJobs = pgTable(
  'agent_runtime_jobs',
  {
    id: text('id').primaryKey(),
    operationId: text('operation_id')
      .notNull()
      .references(() => agentRuntimeCheckpoints.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    message: jsonb('message').$type<Record<string, any>>().notNull(),
    intentHash: text('intent_hash').notNull(),
    status: text('status', {
      enum: ['queued', 'claimed', 'dispatched', 'done', 'unknown', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    priority: integer('priority').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamptz('lease_until'),
    errorCode: text('error_code'),
    notifiedAt: timestamptz('notified_at'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agent_runtime_job_step_unique').on(table.operationId, table.stepIndex),
    index('agent_runtime_job_ready_idx').on(table.status, table.availableAt, table.priority),
    index('agent_runtime_job_lease_idx').on(table.status, table.leaseUntil),
    index('agent_runtime_job_notice_idx').on(table.status, table.notifiedAt),
    index('agent_runtime_job_owner_idx').on(table.userId),
  ],
);

export type NativeAgentJob = typeof agentRuntimeJobs.$inferSelect;
