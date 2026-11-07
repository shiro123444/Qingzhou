import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { ChannelIdentityService } from '@/server/services/bot/channelIdentity';

const identityProcedure = authedProcedure.use(serverDatabase);
const providerInput = z.object({ providerId: z.string().min(1).max(255) });

async function execute<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '无法完成账号绑定操作，请检查机器人状态后重试。',
    });
  }
}

export const channelIdentityRouter = router({
  list: identityProcedure
    .input(providerInput)
    .query(({ ctx, input }) =>
      execute(() => new ChannelIdentityService(ctx.serverDB, ctx.userId).list(input.providerId)),
    ),
  createChallenge: identityProcedure
    .input(providerInput)
    .mutation(({ ctx, input }) =>
      execute(() =>
        new ChannelIdentityService(ctx.serverDB, ctx.userId).createChallenge(input.providerId),
      ),
    ),
  revoke: identityProcedure
    .input(providerInput.extend({ linkId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      execute(() =>
        new ChannelIdentityService(ctx.serverDB, ctx.userId).revoke(input.providerId, input.linkId),
      ),
    ),
  updatePermissions: identityProcedure
    .input(providerInput.extend({ requireBinding: z.boolean() }))
    .mutation(({ ctx, input }) =>
      execute(() =>
        new ChannelIdentityService(ctx.serverDB, ctx.userId).updatePermissions(
          input.providerId,
          input.requireBinding,
        ),
      ),
    ),
});
