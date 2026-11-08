import { FileModel } from '@/database/models/file';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

import { createMusicAccountService } from './account-production';
import { CatalogMusicProvider } from './catalog-provider';
import { KugouMusicProvider } from './kugou-provider';
import { OwnedFileMusicProvider } from './owned-file-provider';

export const createMusicProvider = (db: LobeChatDatabase, userId: string) =>
  new CatalogMusicProvider(
    userId,
    new OwnedFileMusicProvider(userId, new FileModel(db, userId), new FileService(db, userId)),
    new KugouMusicProvider(userId, undefined, createMusicAccountService(db, userId)),
  );
