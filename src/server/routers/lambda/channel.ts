import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { ChannelDigestModel } from '@/database/models/channelDigest';
import { ChannelTaskModel } from '@/database/models/channelTask';
import { agentBotProviders, agents, botInboundEvents } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { digestGroupAllowed } from '@/server/services/bot/digestCapture';
import {
  extractDmSettings,
  extractGroupSettings,
  normalizeAllowFromEntries,
  platformRegistry,
  resolveConnectionMode,
} from '@/server/services/bot/platforms';
import { getBotRuntimeStatus } from '@/server/services/gateway/runtimeStatus';
import type {
  ChannelAccessSettings,
  ChannelActivitySummary,
  ChannelDetail,
  ChannelProviderSummary,
  ManagedChannelPlatform,
} from '@/types/channel';
import { channelDigestSettingsSchema } from '@/types/channelDigest';

const managedPlatforms: ManagedChannelPlatform[] = ['wechat', 'napcat', 'qq', 'feishu', 'lark'];
const procedure = authedProcedure.use(serverDatabase);

/** Project only management metadata. Credentials never leave the provider table. */
function ownedProviders(db: LobeChatDatabase, userId: string, providerId?: string) {
  return db
    .select({
      agentId: agentBotProviders.agentId,
      agentTitle: agents.title,
      applicationId: agentBotProviders.applicationId,
      enabled: agentBotProviders.enabled,
      id: agentBotProviders.id,
      platform: agentBotProviders.platform,
      settings: agentBotProviders.settings,
      updatedAt: agentBotProviders.updatedAt,
    })
    .from(agentBotProviders)
    .leftJoin(agents, and(eq(agents.id, agentBotProviders.agentId), eq(agents.userId, userId)))
    .where(
      and(
        eq(agentBotProviders.userId, userId),
        inArray(agentBotProviders.platform, managedPlatforms),
        providerId ? eq(agentBotProviders.id, providerId) : undefined,
      ),
    )
    .orderBy(desc(agentBotProviders.updatedAt));
}

type Provider = Awaited<ReturnType<typeof ownedProviders>>[number];

async function summarize(provider: Provider): Promise<ChannelProviderSummary> {
  const status = await getBotRuntimeStatus(provider.platform, provider.applicationId);
  return {
    agentId: provider.agentId,
    agentTitle: provider.agentTitle,
    applicationId: provider.applicationId,
    connectionMode: resolveConnectionMode(
      platformRegistry.getPlatform(provider.platform),
      provider.settings,
    ),
    enabled: provider.enabled,
    id: provider.id,
    platform: provider.platform as ManagedChannelPlatform,
    runtimeStatus: {
      applicationId: status.applicationId,
      platform: status.platform,
      status: status.status,
      updatedAt: status.updatedAt,
    },
    updatedAt: provider.updatedAt,
  };
}

function accessSettings(settings: Provider['settings']): ChannelAccessSettings {
  const identity = settings?.channelIdentity;
  return {
    allowFrom: normalizeAllowFromEntries(settings?.allowFrom),
    channelIdentity: {
      requireBinding:
        !!identity &&
        typeof identity === 'object' &&
        'requireBinding' in identity &&
        identity.requireBinding === true,
    },
    dmPolicy: extractDmSettings(settings).policy,
    groupAllowFrom: normalizeAllowFromEntries(settings?.groupAllowFrom),
    groupPolicy: extractGroupSettings(settings).policy,
  };
}

export const channelRouter = router({
  digests: procedure
    .input(z.object({ providerId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [provider] = await ownedProviders(ctx.serverDB, ctx.userId, input.providerId);
      if (!provider) throw new TRPCError({ code: 'NOT_FOUND' });
      const groups = await ctx.serverDB
        .select({ threadId: botInboundEvents.threadId })
        .from(botInboundEvents)
        .where(
          and(
            eq(botInboundEvents.userId, ctx.userId),
            eq(botInboundEvents.platform, provider.platform),
            eq(botInboundEvents.applicationId, provider.applicationId),
            sql`${botInboundEvents.threadId} like ${`${provider.platform}:group:%`}`,
          ),
        )
        .groupBy(botInboundEvents.threadId)
        .orderBy(sql`max(${botInboundEvents.createdAt}) desc`)
        .limit(50);
      return {
        ...(await new ChannelDigestModel(ctx.serverDB).list(ctx.userId, provider.id)),
        groups: groups.filter((group) => digestGroupAllowed(provider.settings, group.threadId)),
        supported: ['napcat', 'qq', 'feishu', 'lark'].includes(provider.platform),
        canSend: ['napcat', 'feishu', 'lark'].includes(provider.platform),
      };
    }),
  saveDigest: procedure.input(channelDigestSettingsSchema).mutation(async ({ ctx, input }) => {
    const [provider] = await ownedProviders(ctx.serverDB, ctx.userId, input.providerId);
    if (!provider) throw new TRPCError({ code: 'NOT_FOUND' });
    if (
      !input.threadId.startsWith(`${provider.platform}:group:`) ||
      (input.enabled && !digestGroupAllowed(provider.settings, input.threadId)) ||
      (input.sendToSource && !['napcat', 'feishu', 'lark'].includes(provider.platform))
    )
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Group or delivery unavailable' });
    const [observed] = await ctx.serverDB
      .select({ id: botInboundEvents.id })
      .from(botInboundEvents)
      .where(
        and(
          eq(botInboundEvents.userId, ctx.userId),
          eq(botInboundEvents.platform, provider.platform),
          eq(botInboundEvents.applicationId, provider.applicationId),
          eq(botInboundEvents.threadId, input.threadId),
        ),
      )
      .limit(1);
    if (!observed)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Group not observed by this bot' });
    await new ChannelDigestModel(ctx.serverDB).save(ctx.userId, provider.id, input);
  }),
  removeDigest: procedure
    .input(z.object({ providerId: z.string().uuid(), ruleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await new ChannelDigestModel(ctx.serverDB).remove(ctx.userId, input.providerId, input.ruleId);
    }),
  tasks: procedure
    .input(z.object({ providerId: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }) => {
      const [provider] = await ownedProviders(ctx.serverDB, ctx.userId, input.providerId);
      if (!provider) throw new TRPCError({ code: 'NOT_FOUND' });
      const tasks = await new ChannelTaskModel(ctx.serverDB, ctx.userId).list(
        provider.platform,
        provider.applicationId,
      );
      return tasks
        .filter((task) => task.agentId === provider.agentId)
        .map(({ id, operationId, completed, delivery, createdAt, updatedAt }) => ({
          id,
          operationId,
          completed,
          delivery,
          createdAt,
          updatedAt,
        }));
    }),
  task: procedure
    .input(
      z.object({
        providerId: z.string().min(1).max(100),
        taskId: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [provider] = await ownedProviders(ctx.serverDB, ctx.userId, input.providerId);
      if (!provider) throw new TRPCError({ code: 'NOT_FOUND' });
      const [task] = await new ChannelTaskModel(ctx.serverDB, ctx.userId).list(
        provider.platform,
        provider.applicationId,
        undefined,
        input.taskId,
      );
      if (!task || task.agentId !== provider.agentId) throw new TRPCError({ code: 'NOT_FOUND' });
      const {
        id,
        operationId,
        completed,
        content,
        artifactIds,
        delivery,
        reason,
        createdAt,
        updatedAt,
        topicId,
      } = task;
      return {
        id,
        operationId,
        completed,
        content,
        artifactIds,
        delivery,
        reason,
        createdAt,
        updatedAt,
        topicId,
        provider: await summarize(provider),
      };
    }),
  list: procedure.query(async ({ ctx }): Promise<ChannelProviderSummary[]> => {
    const providers = await ownedProviders(ctx.serverDB, ctx.userId);
    return Promise.all(providers.map(summarize));
  }),

  detail: procedure
    .input(z.object({ providerId: z.string().min(1).max(100) }))
    .query(async ({ ctx, input }): Promise<ChannelDetail> => {
      const [provider] = await ownedProviders(ctx.serverDB, ctx.userId, input.providerId);
      if (!provider) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' });
      const recent = await ctx.serverDB
        .select({
          attempts: botInboundEvents.attempts,
          createdAt: botInboundEvents.createdAt,
          id: botInboundEvents.id,
          status: botInboundEvents.status,
          updatedAt: botInboundEvents.updatedAt,
        })
        .from(botInboundEvents)
        .where(
          and(
            eq(botInboundEvents.userId, ctx.userId),
            eq(botInboundEvents.platform, provider.platform),
            eq(botInboundEvents.applicationId, provider.applicationId),
          ),
        )
        .orderBy(desc(botInboundEvents.createdAt), desc(botInboundEvents.id))
        .limit(30);
      const activity: ChannelActivitySummary[] = recent.map((event) => ({
        attempts: event.attempts,
        createdAt: event.createdAt,
        direction: 'inbound',
        id: event.id,
        status: event.status,
        updatedAt: event.updatedAt,
      }));
      return {
        activity,
        provider: await summarize(provider),
        settings: accessSettings(provider.settings),
      };
    }),
});
