import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz } from './_helpers';
import { users } from './user';

/** Append-only human observations. These do not change execution or permit replay. */
export const agentActivityReviews = pgTable(
  'agent_activity_reviews',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category', { enum: ['agent', 'wake'] }).notNull(),
    activityId: text('activity_id').notNull(),
    incidentToken: text('incident_token').notNull(),
    decision: text('decision', { enum: ['effect_confirmed', 'no_effect', 'closed'] }).notNull(),
    evidence: text('evidence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('agent_activity_review_incident_idx').on(
      t.userId,
      t.category,
      t.activityId,
      t.incidentToken,
    ),
  ],
);

/** One random identity per worker incarnation; never reused by a restarted process. */
export const agentWorkerHeartbeats = pgTable(
  'agent_worker_heartbeats',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['agent', 'wake'] }).notNull(),
    phase: text('phase', { enum: ['idle', 'busy', 'degraded', 'stopping', 'stopped'] }).notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    heartbeatAt: timestamptz('heartbeat_at').notNull().defaultNow(),
    lastPollAt: timestamptz('last_poll_at'),
    lastSuccessAt: timestamptz('last_success_at'),
    lastFailureAt: timestamptz('last_failure_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (t) => [index('agent_worker_heartbeat_kind_idx').on(t.kind, t.heartbeatAt)],
);
