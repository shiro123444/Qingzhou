import { and, eq } from 'drizzle-orm';

import { agents } from '@/database/schemas/agent';
import { aiModels, aiProviders } from '@/database/schemas/aiInfra';
import type { LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

export const COMPUTER_DEEPSEEK_MODEL = 'deepseek-v4.1-flash';
export const COMPUTER_MODEL_GATEWAY = 'https://cli.tinimodel.com/v1';

/** Exact remote model + owned provider. Does not mutate ordinary chat configuration. */
export async function resolveComputerModel(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
  decrypt: (
    value: string | null,
    userId: string,
  ) => Promise<unknown> = KeyVaultsGateKeeper.getUserKeyVaults,
): Promise<{ model: string; provider: string }> {
  const [agent] = await db
    .select({ provider: agents.provider })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!agent) throw new Error('COMPUTER_MODEL_SCOPE_UNAVAILABLE');
  const model = process.env.QINGZHOU_COMPUTER_MODEL?.trim() || COMPUTER_DEEPSEEK_MODEL;
  if (!/^deepseek[-/]/i.test(model)) throw new Error('COMPUTER_MODEL_POLICY_INVALID');
  const rows = await db
    .select({ provider: aiProviders.id, keyVaults: aiProviders.keyVaults })
    .from(aiProviders)
    .innerJoin(
      aiModels,
      and(
        eq(aiModels.providerId, aiProviders.id),
        eq(aiModels.userId, userId),
        eq(aiModels.id, model),
        eq(aiModels.enabled, true),
        eq(aiModels.type, 'chat'),
        eq(aiModels.source, 'remote'),
      ),
    )
    .where(and(eq(aiProviders.userId, userId), eq(aiProviders.enabled, true)));
  const matches: string[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = await decrypt(row.keyVaults, userId);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const vault = value as Record<string, unknown>;
    if (
      typeof vault.baseURL !== 'string' ||
      typeof vault.apiKey !== 'string' ||
      !vault.apiKey.trim()
    )
      continue;
    try {
      const url = new URL(vault.baseURL);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        `${url.origin}${url.pathname.replace(/\/$/, '')}` !== COMPUTER_MODEL_GATEWAY
      )
        continue;
    } catch {
      continue;
    }
    matches.push(row.provider);
  }
  const explicit = process.env.QINGZHOU_COMPUTER_MODEL_PROVIDER?.trim() || undefined;
  const preferred = explicit ?? agent.provider;
  const provider =
    preferred && matches.includes(preferred)
      ? preferred
      : matches.length === 1 && !explicit
        ? matches[0]
        : undefined;
  if (!provider) throw new Error('COMPUTER_MODEL_UNAVAILABLE');
  return { model, provider };
}
