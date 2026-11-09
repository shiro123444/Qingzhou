import { and, eq } from 'drizzle-orm';

import {
  agentBotProviders,
  type ChannelDigestRule,
  channelDigestRules,
  type ChannelDigestRun,
  channelDigestRuns,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import type { BotCallbackBody } from './BotCallbackService';
import { deliveryEnvelope } from './deliveryEnvelope';
import { digestGroupAllowed } from './digestCapture';

export function digestCallback(
  run: ChannelDigestRun,
  rule: ChannelDigestRule,
  provider: { agentId: string; applicationId: string },
): BotCallbackBody {
  return {
    type: 'completion',
    userId: rule.userId,
    agentId: provider.agentId,
    applicationId: provider.applicationId,
    operationId: `channel-digest:${run.id}`,
    platformThreadId: rule.threadId,
    digestRunId: run.id,
    lastAssistantContent: run.content ?? '',
    reason: 'completed',
  };
}

/** Scheduled work is authorized by the owner's exact, revocable rule, never a forged sender. */
export async function assertDigestDeliveryAccess(db: LobeChatDatabase, body: BotCallbackBody) {
  if (!body.digestRunId || !body.userId) throw new Error('invalid_digest_delivery');
  const [row] = await db
    .select({
      run: channelDigestRuns,
      rule: channelDigestRules,
      provider: {
        agentId: agentBotProviders.agentId,
        applicationId: agentBotProviders.applicationId,
        platform: agentBotProviders.platform,
        enabled: agentBotProviders.enabled,
        settings: agentBotProviders.settings,
      },
    })
    .from(channelDigestRuns)
    .innerJoin(channelDigestRules, eq(channelDigestRuns.ruleId, channelDigestRules.id))
    .innerJoin(
      agentBotProviders,
      and(
        eq(channelDigestRules.providerId, agentBotProviders.id),
        eq(agentBotProviders.userId, body.userId),
      ),
    )
    .where(
      and(eq(channelDigestRuns.id, body.digestRunId), eq(channelDigestRules.userId, body.userId)),
    );
  if (
    !row ||
    !row.provider.enabled ||
    !row.rule.enabled ||
    !row.rule.sendToSource ||
    row.run.status !== 'completed' ||
    row.run.revision !== row.rule.revision ||
    !['napcat', 'feishu', 'lark'].includes(row.provider.platform) ||
    !digestGroupAllowed(row.provider.settings, row.rule.threadId) ||
    deliveryEnvelope(digestCallback(row.run, row.rule, row.provider)).intentHash !==
      deliveryEnvelope(body).intentHash
  )
    throw new Error('digest_delivery_revoked');
}
