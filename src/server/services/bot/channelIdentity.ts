import { createHash, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { MessengerAccountLinkModel } from '@/database/models/messengerAccountLink';
import { agentBotProviders, messengerAccountLinks } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import {
  assertIdentityChallengeClaim,
  claimIdentityChallenge,
  createIdentityChallenge,
  releaseIdentityChallenge,
} from './channelIdentityStore';

export const supportsChannelIdentity = (platform: string) =>
  ['wechat', 'qq', 'feishu', 'lark'].includes(platform);
export const channelIdentityTenant = (provider: {
  applicationId: string;
  id: string;
  platform: string;
}) =>
  `bot:${provider.id}:${createHash('sha256')
    .update(JSON.stringify([provider.platform, provider.applicationId]))
    .digest('hex')}`;

const policy = (settings: Record<string, unknown> | null) => {
  const value = settings?.channelIdentity as
    { requireBinding?: boolean; revision?: string } | undefined;
  return {
    requireBinding: value?.requireBinding === true,
    revision: typeof value?.revision === 'string' ? value.revision : '',
  };
};

export class ChannelIdentityService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
  ) {}

  private async provider(providerId: string) {
    const row = await new AgentBotProviderModel(this.db, this.userId).findById(providerId);
    if (!row || !supportsChannelIdentity(row.platform))
      throw new Error('Channel identity is unavailable');
    return row;
  }

  async list(providerId: string) {
    const provider = await this.provider(providerId);
    const identities = (await new MessengerAccountLinkModel(this.db, this.userId).list())
      .filter(
        (row) =>
          row.platform === provider.platform && row.tenantId === channelIdentityTenant(provider),
      )
      .map(({ id, platform, platformUserId, platformUsername, createdAt }) => ({
        id,
        platform,
        platformUserId,
        platformUsername,
        createdAt,
      }));
    return {
      identities,
      permissions: { requireBinding: policy(provider.settings).requireBinding },
      supported: true,
    };
  }

  async createChallenge(providerId: string) {
    return this.db.transaction(async (tx) => {
      const [provider] = await tx
        .select()
        .from(agentBotProviders)
        .where(and(eq(agentBotProviders.id, providerId), eq(agentBotProviders.userId, this.userId)))
        .for('update');
      if (!provider?.enabled || !supportsChannelIdentity(provider.platform))
        throw new Error('Channel identity is unavailable');
      const revision = randomUUID();
      await tx
        .update(agentBotProviders)
        .set({
          settings: {
            ...provider.settings,
            channelIdentity: { ...policy(provider.settings), revision },
          },
          updatedAt: new Date(),
        })
        .where(eq(agentBotProviders.id, provider.id));
      return createIdentityChallenge(getAgentRuntimeRedisClient(), {
        applicationId: provider.applicationId,
        platform: provider.platform,
        providerId,
        revision,
        userId: this.userId,
      });
    });
  }

  async updatePermissions(providerId: string, requireBinding: boolean) {
    await this.db.transaction(async (tx) => {
      const [provider] = await tx
        .select()
        .from(agentBotProviders)
        .where(and(eq(agentBotProviders.id, providerId), eq(agentBotProviders.userId, this.userId)))
        .for('update');
      if (!provider || !supportsChannelIdentity(provider.platform))
        throw new Error('Channel identity is unavailable');
      await tx
        .update(agentBotProviders)
        .set({
          settings: {
            ...provider.settings,
            channelIdentity: { requireBinding, revision: randomUUID() },
          },
          updatedAt: new Date(),
        })
        .where(eq(agentBotProviders.id, provider.id));
    });
    return { ok: true as const };
  }

  async revoke(providerId: string, linkId: string) {
    await this.db.transaction(async (tx) => {
      const [provider] = await tx
        .select()
        .from(agentBotProviders)
        .where(and(eq(agentBotProviders.id, providerId), eq(agentBotProviders.userId, this.userId)))
        .for('update');
      if (!provider || !supportsChannelIdentity(provider.platform))
        throw new Error('Channel identity is unavailable');
      const removed = await tx
        .delete(messengerAccountLinks)
        .where(
          and(
            eq(messengerAccountLinks.id, linkId),
            eq(messengerAccountLinks.userId, this.userId),
            eq(messengerAccountLinks.platform, provider.platform),
            eq(messengerAccountLinks.tenantId, channelIdentityTenant(provider)),
          ),
        )
        .returning({ id: messengerAccountLinks.id });
      if (!removed.length) throw new Error('Identity binding was not found');
      await tx
        .update(agentBotProviders)
        .set({
          settings: {
            ...provider.settings,
            channelIdentity: { ...policy(provider.settings), revision: randomUUID() },
          },
          updatedAt: new Date(),
        })
        .where(eq(agentBotProviders.id, provider.id));
    });
    return { ok: true as const };
  }

  async completeChallenge(providerId: string, code: string, senderId: string, senderName?: string) {
    const redis = getAgentRuntimeRedisClient();
    const claim = await claimIdentityChallenge(
      redis,
      providerId,
      code.trim().toUpperCase(),
      senderId,
    );
    let committed = false;
    try {
      await this.db.transaction(async (tx) => {
        const [provider] = await tx
          .select()
          .from(agentBotProviders)
          .where(
            and(eq(agentBotProviders.id, providerId), eq(agentBotProviders.userId, this.userId)),
          )
          .for('update');
        const challenge = claim.challenge;
        if (
          !provider?.enabled ||
          !supportsChannelIdentity(provider.platform) ||
          challenge.userId !== this.userId ||
          challenge.providerId !== providerId ||
          challenge.platform !== provider.platform ||
          challenge.applicationId !== provider.applicationId ||
          challenge.revision !== policy(provider.settings).revision
        )
          throw new Error('Binding code is invalid or expired');
        await assertIdentityChallengeClaim(redis!, providerId, claim);
        await new MessengerAccountLinkModel(
          tx as unknown as LobeChatDatabase,
          this.userId,
        ).upsertForPlatform({
          platform: provider.platform,
          platformUserId: senderId,
          platformUsername: senderName,
          tenantId: channelIdentityTenant(provider),
          activeAgentId: provider.agentId,
        });
        await tx
          .update(agentBotProviders)
          .set({
            settings: {
              ...provider.settings,
              channelIdentity: { ...policy(provider.settings), requireBinding: true },
            },
            updatedAt: new Date(),
          })
          .where(eq(agentBotProviders.id, provider.id));
      });
      committed = true;
    } finally {
      await releaseIdentityChallenge(redis!, providerId, claim, committed);
    }
    return { ok: true as const };
  }

  static async resolveAccess(
    db: LobeChatDatabase,
    platform: string,
    applicationId: string,
    senderId?: string,
    expected?: { agentId?: string; userId: string },
  ) {
    if (!supportsChannelIdentity(platform))
      return { enforced: false, allowed: true, operatorUserId: undefined };
    const provider = await AgentBotProviderModel.findByPlatformAndAppId(
      db,
      platform,
      applicationId,
    );
    if (
      !provider?.enabled ||
      (expected &&
        (expected.userId !== provider.userId ||
          (expected.agentId !== undefined && expected.agentId !== provider.agentId)))
    )
      return { enforced: true, allowed: false, operatorUserId: undefined };
    if (!policy(provider.settings).requireBinding)
      return { enforced: false, allowed: true, operatorUserId: undefined };
    const identity = await new MessengerAccountLinkModel(db, provider.userId).findByPlatform(
      platform,
      channelIdentityTenant(provider),
    );
    return {
      enforced: true,
      allowed: !!senderId && identity?.platformUserId === senderId,
      operatorUserId: identity?.platformUserId,
    };
  }
}
