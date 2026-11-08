import type { LobeChatDatabase } from '@/database/type';

import { MusicAccountService } from './account-service';
import { DatabaseMusicAccountStore } from './account-store';

export const createMusicAccountService = (db: LobeChatDatabase, userId: string) =>
  new MusicAccountService(new DatabaseMusicAccountStore(db, userId));
