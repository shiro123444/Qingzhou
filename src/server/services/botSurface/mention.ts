import { CordisProfileLoader } from '@lobechat/cordis-runtime';
import { TRPCError } from '@trpc/server';

import { BUILTIN_PLUGINS, type BuiltinPluginId } from '@/config/builtinPlugins';
import { AgentModel } from '@/database/models/agent';
import type { LobeChatDatabase } from '@/database/type';
import { assertBuiltinPluginEnabled } from '@/server/runtime/builtin-plugins';

type Ask = (prompt: string) => Promise<{ topicId: string }>;
declare module '@lobechat/cordis-foundation' {
  interface Context {
    'qingzhou.bot.ask': Ask;
  }
}

/** Bind account and recipient before installing the ask-only service. No runtime handles escape the call. */
export async function requestBot(
  db: LobeChatDatabase,
  userId: string,
  input: { source?: BuiltinPluginId; agentId: string; prompt: string },
) {
  const manifest = input.source
    ? BUILTIN_PLUGINS[input.source]
    : { id: 'chat', version: '1.0.0', botMention: true };
  if (input.source) assertBuiltinPluginEnabled(input.source);
  if (!manifest.botMention) throw new TRPCError({ code: 'FORBIDDEN' });
  if (!(await new AgentModel(db, userId).existsById(input.agentId)))
    throw new TRPCError({ code: 'NOT_FOUND' });
  const host = new CordisProfileLoader({
    profile: { bundles: ['mention'] },
    bundles: { mention: { entries: [{ id: manifest.id, use: 'surface' }] } },
    modules: {
      surface: {
        manifest,
        load: async () => {
          const { AiAgentService } = await import('@/server/services/aiAgent');
          const executor = new AiAgentService(db, userId);
          return {
            apply(ctx) {
              ctx.provide('qingzhou.bot.ask', async (prompt: string) => {
                const result = await executor.execAgent({
                  agentId: input.agentId,
                  prompt,
                  trigger: 'chat',
                  clientRuntime: 'web',
                  disableLocalSystem: true,
                  userInterventionConfig: { approvalMode: 'manual' },
                });
                if (!result.success || !result.topicId)
                  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
                return { topicId: result.topicId };
              });
            },
          };
        },
      },
    },
  });
  try {
    return await host.run(async (ctx) => {
      const ask = ctx.get('qingzhou.bot.ask');
      if (!ask) throw new Error('BOT_SURFACE_UNAVAILABLE');
      return ask(input.prompt);
    });
  } finally {
    await host.dispose();
  }
}
