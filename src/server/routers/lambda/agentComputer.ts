import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { ComputerError } from '@/server/runtime/computer/provider';
import { isNativeAgentRuntimeEnabled } from '@/server/runtime/tasks/mode';
import { AgentComputerService } from '@/server/services/agentComputer';
import { computerHumanCommandSchema } from '@/types/agentComputer';
import { uiAttentionSchema } from '@/types/uiAttention';

const procedure = authedProcedure
  .use(async ({ next }) => {
    if (!isNativeAgentRuntimeEnabled()) throw new TRPCError({ code: 'PRECONDITION_FAILED' });
    return next();
  })
  .use(serverDatabase);
async function call<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ComputerError)
      throw new TRPCError({
        code:
          error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : error.code === 'DISABLED'
              ? 'PRECONDITION_FAILED'
              : 'CONFLICT',
        message: error.message,
      });
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'COMPUTER_UNAVAILABLE' });
  }
}
const agentId = z.string().min(1).max(256);
export const agentComputerRouter = router({
  startTask: procedure
    .input(
      z
        .object({
          agentId,
          prompt: z.string().trim().min(1).max(8000),
          uiAttention: uiAttentionSchema.optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      call(() =>
        new AgentComputerService(ctx.serverDB, ctx.userId).startTask(
          input.agentId,
          input.prompt,
          input.uiAttention,
        ),
      ),
    ),
  observe: procedure
    .input(z.object({ agentId, expectedRevision: z.number().int().min(1) }).strict())
    .mutation(({ ctx, input }) =>
      call(() =>
        new AgentComputerService(ctx.serverDB, ctx.userId).observe(
          input.agentId,
          input.expectedRevision,
        ),
      ),
    ),
  reconcile: procedure
    .input(z.object({ agentId, commandId: z.string().uuid() }).strict())
    .mutation(({ ctx, input }) =>
      call(() =>
        new AgentComputerService(ctx.serverDB, ctx.userId).reconcile(
          input.agentId,
          input.commandId,
        ),
      ),
    ),
  get: procedure
    .input(z.object({ agentId }).strict())
    .query(({ ctx, input }) =>
      call(() => new AgentComputerService(ctx.serverDB, ctx.userId).get(input.agentId)),
    ),
  manage: procedure
    .input(
      z
        .object({
          agentId,
          command: computerHumanCommandSchema,
          requestId: z.string().uuid(),
          expectedRevision: z.number().int().min(0),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      call(() => new AgentComputerService(ctx.serverDB, ctx.userId).manage(input)),
    ),
});
