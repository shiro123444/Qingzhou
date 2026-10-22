import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';

import { updatedAt } from './_helpers';
import { users } from './user';

/** One short-transaction row serializes allocation and dispatch admission for a learning cycle. */
export const learningBudgetRoots = pgTable(
  'learning_budget_roots',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rootId: text('root_id').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.rootId] })],
);
