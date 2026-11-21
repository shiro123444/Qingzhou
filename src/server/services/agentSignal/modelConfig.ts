import { INBOX_SESSION_ID } from '@lobechat/const';
import type { UserSystemAgentConfig } from '@lobechat/types';

import { AgentModel } from '@/database/models/agent';
import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';

/** Background work uses its owning agent's configured provider and model together. */
export async function resolveAgentSignalModelConfig(
  db: LobeChatDatabase,
  userId: string,
  agentId?: string,
): Promise<{ model: string; provider: string }> {
  if (agentId) {
    const config = await new AgentModel(db, userId).getAgentModelConfig(agentId);
    if (!config) throw new Error('AGENT_SIGNAL_MODEL_SCOPE_UNAVAILABLE');
    return config;
  }
  const settings = await new UserModel(db, userId).getUserSettings();
  const config = (settings?.systemAgent as Partial<UserSystemAgentConfig> | undefined)?.topic;
  if (config?.model && config.provider) return { model: config.model, provider: config.provider };
  const inbox = await new AgentModel(db, userId).getAgentModelConfig(INBOX_SESSION_ID);
  if (inbox) return inbox;
  throw new Error('AGENT_SIGNAL_MODEL_NOT_CONFIGURED');
}
