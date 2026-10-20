import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { FileModel } from '@/database/models/file';
import { agentOperations, messagePlugins, messages } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { FileService } from '@/server/services/file';
import { SystemCapabilityIdentifier } from '@/server/services/toolExecution/systemCapabilityManifest';

const intentSchema = z.object({
  operationId: z.string(),
  artifacts: z.array(z.object({ fileId: z.string().uuid() })).max(16),
});

/** File IDs come from persisted server tool state, never assistant prose or URLs. */
export class BotArtifactService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {}

  async list(operationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ state: messagePlugins.state })
      .from(messagePlugins)
      .innerJoin(messages, eq(messages.id, messagePlugins.id))
      .innerJoin(agentOperations, eq(agentOperations.id, operationId))
      .where(
        and(
          eq(messagePlugins.userId, this.userId),
          eq(messages.userId, this.userId),
          eq(agentOperations.userId, this.userId),
          eq(messages.topicId, agentOperations.topicId),
          eq(messagePlugins.identifier, SystemCapabilityIdentifier),
          eq(messagePlugins.apiName, 'invoke'),
          eq(messages.role, 'tool'),
          isNull(messagePlugins.error),
          sql`${messagePlugins.state}->'botDelivery'->>'operationId' = ${operationId}`,
        ),
      )
      .orderBy(messages.createdAt)
      .limit(16);
    const ids = rows.flatMap(({ state }) => {
      const parsed = intentSchema.safeParse((state as any)?.botDelivery);
      return parsed.success && parsed.data.operationId === operationId
        ? parsed.data.artifacts.map(({ fileId }) => fileId)
        : [];
    });
    return [...new Set(ids)];
  }

  async read(fileId: string) {
    const file = await new FileModel(this.db, this.userId).findById(fileId);
    if (!file) throw new Error('Reply file is not owned by this account');
    if (file.size < 1 || file.size > 25 * 1024 * 1024) throw new Error('Reply file exceeds 25 MiB');
    const bytes = Buffer.from(
      await new FileService(this.db, this.userId).getFileByteArray(file.url),
    );
    if (bytes.length !== file.size) throw new Error('Reply file size changed');
    // eslint-disable-next-line no-control-regex -- Reject control characters in attachment filenames.
    const filename = file.name.replaceAll(/[\x00-\x1F/\\]/gu, '_').slice(-200) || 'artifact';
    return { bytes, filename, mimeType: file.fileType };
  }
}
