import { pgTable, text } from 'drizzle-orm/pg-core';

import { updatedAt } from './_helpers';
import { users } from './user';

/** Server-only AES-GCM envelope, including pending QR state and provider credentials. */
export const musicAccounts = pgTable('music_accounts', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  revision: text('revision').notNull(),
  encryptedState: text('encrypted_state').notNull(),
  updatedAt: updatedAt(),
});
