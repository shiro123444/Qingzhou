import { and, eq } from 'drizzle-orm';

import { ChannelTaskModel } from '@/database/models/channelTask';
import { agentBotProviders, agentOperations } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { BotArtifactService } from './BotArtifactService';
import type { BotCallbackBody } from './BotCallbackService';

export class ChannelTaskService {
  constructor(private readonly db: LobeChatDatabase) {}

  async record(body: BotCallbackBody) {
    const platform = body.platformThreadId.split(':')[0];
    if (
      !['wechat', 'qq', 'feishu', 'lark'].includes(platform) ||
      body.messengerInstallationKey ||
      !body.userId ||
      !body.operationId ||
      !body.agentId ||
      !body.senderExternalUserId
    )
      return;
    const [owner] = await this.db
      .select({ id: agentBotProviders.id })
      .from(agentBotProviders)
      .innerJoin(
        agentOperations,
        and(
          eq(agentOperations.id, body.operationId),
          eq(agentOperations.userId, body.userId),
          eq(agentOperations.agentId, body.agentId),
        ),
      )
      .where(
        and(
          eq(agentBotProviders.userId, body.userId),
          eq(agentBotProviders.platform, platform),
          eq(agentBotProviders.applicationId, body.applicationId),
          eq(agentBotProviders.agentId, body.agentId),
        ),
      )
      .limit(1);
    if (!owner) throw new Error('channel_task_owner_mismatch');
    const completed = body.type === 'completion';
    return new ChannelTaskModel(this.db, body.userId).record({
      agentId: body.agentId,
      applicationId: body.applicationId,
      artifactIds: completed
        ? await new BotArtifactService(this.db, body.userId).list(body.operationId)
        : [],
      completed,
      content: completed
        ? body.lastAssistantContent ||
          body.lastLLMContent ||
          body.content ||
          body.errorMessage ||
          ''
        : '',
      delivery: 'pending',
      operationId: body.operationId,
      platform,
      platformThreadId: body.platformThreadId,
      reason: body.reason,
      senderExternalUserId: body.senderExternalUserId,
      topicId: body.topicId,
    });
  }
}
