import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { timestamps, timestamptz } from './_helpers';
import { agents } from './agent';
import { users } from './user';

export const agentComputerSessions = pgTable(
  'agent_computer_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    providerBinding: text('provider_binding').notNull(),
    resourceId: text('resource_id'),
    state: text('state', { enum: ['new', 'ready', 'sleeping', 'unknown'] })
      .notNull()
      .default('new'),
    control: text('control', { enum: ['agent', 'human'] })
      .notNull()
      .default('agent'),
    revision: integer('revision').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamptz('lease_until'),
    leaseCommandId: text('lease_command_id'),
    ...timestamps,
  },
  (t) => [uniqueIndex('agent_computer_scope_idx').on(t.userId, t.agentId)],
);

export const agentComputerCommands = pgTable(
  'agent_computer_commands',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentComputerSessions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestKey: text('request_key').notNull(),
    inputHash: text('input_hash').notNull(),
    actor: text('actor', { enum: ['agent', 'human'] }).notNull(),
    kind: text('kind', {
      enum: ['ensure', 'wake', 'sleep', 'control', 'shell', 'browser'],
    }).notNull(),
    status: text('status', { enum: ['prepared', 'dispatched', 'done', 'unknown', 'cancelled'] })
      .notNull()
      .default('prepared'),
    revision: integer('revision').notNull(),
    expectedState: text('expected_state', { enum: ['ready', 'sleeping'] }),
    expectedControl: text('expected_control', { enum: ['agent', 'human'] }),
    receipt: jsonb('receipt').$type<{
      resourceId: string;
      state: 'ready' | 'sleeping';
      control: 'agent' | 'human';
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    }>(),
    completedAt: timestamptz('completed_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('agent_computer_request_idx').on(t.sessionId, t.requestKey),
    index('agent_computer_command_owner_idx').on(t.userId, t.createdAt),
  ],
);
