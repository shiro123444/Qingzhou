import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AgentOperationModel } from '@/database/models/agentOperation';
import { BotDeliveryConflict, BotDeliveryModel } from '@/database/models/botDelivery';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { callbackScopeKey } from '@/server/services/bot/callbackLedger';
import { wakeBotDelivery } from '@/server/services/bot/deliveryWake';
import { PostgresCallbackLedger } from '@/server/services/bot/postgresCallbackLedger';

const procedure = authedProcedure.use(serverDatabase);
const scopeKey = z.string().regex(/^[a-f\d]{64}$/);
const evidence = z.string().trim().min(8).max(2000);
const note = z.string().trim().min(8).max(1000);

function safeError(error: unknown): never {
  if (error instanceof BotDeliveryConflict)
    throw new TRPCError({ code: 'CONFLICT', message: error.code });
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Delivery storage unavailable' });
}

/** All reads and writes use ctx.userId, never a user ID supplied by the caller. */
export const botDeliveryRouter = router({
  importLegacy: procedure
    .input(
      z.object({
        applicationId: z.string().min(1).max(512),
        messengerInstallationKey: z.string().min(1).max(512).optional(),
        operationId: z.string().min(1).max(512),
        platformThreadId: z.string().min(1).max(4096),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const operation = await new AgentOperationModel(ctx.serverDB, ctx.userId).findById(
          input.operationId,
        );
        if (!operation) throw new BotDeliveryConflict('operation_not_found');
        // Never accept a precomputed key here: the source hash must bind the authenticated user.
        const key = callbackScopeKey({ ...input, type: 'completion', userId: ctx.userId });
        await new PostgresCallbackLedger(ctx.serverDB, ctx.userId).importLegacy(key);
        return { scopeKey: key };
      } catch (error) {
        return safeError(error);
      }
    }),
  list: procedure
    .input(
      z
        .object({
          before: z
            .object({ createdAt: z.string().datetime(), id: z.string().max(100) })
            .optional(),
          limit: z.number().int().min(1).max(100).default(30),
          status: z
            .enum(['pending', 'running', 'transferred', 'delivered', 'unknown', 'dead'])
            .optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await new BotDeliveryModel(ctx.serverDB).list(
          ctx.userId,
          input?.before,
          input?.limit,
          input?.status,
        );
      } catch (error) {
        return safeError(error);
      }
    }),
  inspect: procedure.input(z.object({ scopeKey })).query(async ({ ctx, input }) => {
    try {
      return await new BotDeliveryModel(ctx.serverDB).inspect(ctx.userId, input.scopeKey);
    } catch (error) {
      return safeError(error);
    }
  }),
  reconcile: procedure
    .input(
      z.object({
        acknowledgeDuplicateRisk: z.literal(true),
        effectId: z.string().min(1).max(160),
        evidence,
        expectedRevision: z.number().int().nonnegative(),
        note,
        resolution: z.enum(['confirmed_delivered', 'confirmed_not_delivered']),
        scopeKey,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await new BotDeliveryModel(ctx.serverDB).reconcile(ctx.userId, input);
        wakeBotDelivery(ctx.serverDB);
        return result;
      } catch (error) {
        return safeError(error);
      }
    }),
  retryDead: procedure
    .input(z.object({ evidence, jobId: z.string().regex(/^(inbox|outbox):[a-f\d]{64}$/), note }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await new BotDeliveryModel(ctx.serverDB).retryDead(ctx.userId, input);
        wakeBotDelivery(ctx.serverDB);
        return result;
      } catch (error) {
        return safeError(error);
      }
    }),
});
