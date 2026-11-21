import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { isNativeAgentRuntimeEnabled } from '@/server/runtime/tasks/mode';
import { BackgroundActivityService } from '@/server/services/backgroundActivity';
import { ActivityHealthService } from '@/server/services/backgroundActivity/health';
import { ActivityReviewService } from '@/server/services/backgroundActivity/review';
import { ACTIVITY_FILTERS, REVIEW_DECISIONS } from '@/types/backgroundActivity';

const nativeProcedure = authedProcedure
  .use(async ({ next }) => {
    if (!isNativeAgentRuntimeEnabled())
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Native background activity is not enabled',
      });
    return next();
  })
  .use(serverDatabase);
const identity = { category: z.enum(['agent', 'wake']), id: z.string().min(1).max(1024) };

export const backgroundActivityRouter = router({
  health: nativeProcedure.query(({ ctx }) =>
    new ActivityHealthService(ctx.serverDB, ctx.userId).get(),
  ),
  reviewHistory: nativeProcedure
    .input(z.object(identity).strict())
    .query(({ ctx, input }) =>
      new ActivityReviewService(ctx.serverDB, ctx.userId).history(input.category, input.id),
    ),
  recordReview: nativeProcedure
    .input(
      z
        .object({
          ...identity,
          incidentToken: z.string().regex(/^[a-f0-9]{32}$/),
          decision: z.enum(REVIEW_DECISIONS),
          evidence: z.string().trim().min(10).max(2000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      new ActivityReviewService(ctx.serverDB, ctx.userId).record(input),
    ),
  list: nativeProcedure
    .input(
      z
        .object({
          filter: z.enum(ACTIVITY_FILTERS).default('all'),
          limit: z.number().int().min(1).max(50).default(25),
          cursor: z
            .object({
              id: z.string().min(1).max(1024),
              category: z.enum(['agent', 'wake']),
              createdAt: z.string().datetime({ precision: 6 }),
            })
            .strict()
            .optional(),
        })
        .strict()
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      return new BackgroundActivityService(ctx.serverDB, ctx.userId).list(input);
    }),
});
