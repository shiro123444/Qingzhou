import { FileModel } from '@/database/models/file';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';

import { OwnedFileMusicProvider } from './owned-file-provider';

export const createMusicProvider = (db: LobeChatDatabase, userId: string) =>
  new OwnedFileMusicProvider(userId, new FileModel(db, userId), new FileService(db, userId));
