import { type ProviderConfig } from '@lobechat/types';
import { ModelProvider } from 'model-bank';

import { AiProviderModel } from '@/database/models/aiProvider';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { type LobeChatDatabase } from '@/database/type';
import { getServerGlobalConfig } from '@/server/globalConfig';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  buildPayloadFromKeyVaults,
  getParamsFromPayload,
  resolveRuntimeProvider,
} from '@/server/modules/ModelRuntime';
import { AgentService } from '@/server/services/agent';

/** Server-only credentials. Never serialize this object to a client or log it. */
export interface UserChatProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** The user's provider ID, not the underlying SDK type. */
  provider: string;
  supportsVision: boolean;
}

export class UserChatProviderConfigurationError extends Error {
  constructor() {
    super('The selected chat provider is unavailable or unsupported. Check your chat settings.');
    this.name = 'UserChatProviderConfigurationError';
  }
}

/**
 * Resolve the inbox selection on every call, with the same credential precedence as chat.
 * Only the OpenAI SDK is supported for now (including custom OpenAI-compatible providers).
 * Other SDKs must be explicitly integrated, never redirected to an OpenAI endpoint.
 */
export const resolveUserChatProvider = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<UserChatProviderConfig> => {
  try {
    if (!userId.trim()) throw new UserChatProviderConfigurationError();

    const agent = await new AgentService(db, userId).getAgentConfig('inbox');
    if (!agent?.provider || !agent.model) throw new UserChatProviderConfigurationError();

    const { model, provider } = agent;
    const providerConfig = await new AiProviderModel(db, userId).getAiProviderById(
      provider,
      KeyVaultsGateKeeper.getUserKeyVaults,
    );
    if (!providerConfig || providerConfig.enabled === false) {
      throw new UserChatProviderConfigurationError();
    }

    // Builtin providers retain their SDK regardless of a settings.sdkType override.
    const runtimeProvider = resolveRuntimeProvider(provider, providerConfig.settings?.sdkType);
    if (runtimeProvider !== ModelProvider.OpenAI) throw new UserChatProviderConfigurationError();

    // Use the same merged builtin/server/user metadata as the model settings API.
    const { aiProvider } = await getServerGlobalConfig();
    const models = await new AiInfraRepos(
      db,
      userId,
      aiProvider as Record<string, ProviderConfig>,
    ).getAiProviderModelList(provider);
    const selectedModel = models.find((item) => item.id === model);
    if (selectedModel?.enabled !== true || selectedModel.type !== 'chat') {
      throw new UserChatProviderConfigurationError();
    }

    const payload = buildPayloadFromKeyVaults(providerConfig.keyVaults || {}, runtimeProvider);
    const params = getParamsFromPayload(runtimeProvider, payload);
    const apiKey = 'apiKey' in params ? params.apiKey : undefined;
    const baseURL =
      ('baseURL' in params ? params.baseURL : undefined) || 'https://api.openai.com/v1';
    if (typeof apiKey !== 'string' || !apiKey.trim() || typeof baseURL !== 'string') {
      throw new UserChatProviderConfigurationError();
    }

    const endpoint = new URL(baseURL);
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    ) {
      throw new UserChatProviderConfigurationError();
    }

    return {
      apiKey,
      baseURL,
      model,
      provider,
      supportsVision: selectedModel.abilities?.vision === true,
    };
  } catch {
    // DB/decryption/URL errors may contain credentials. Do not log or preserve their cause.
    throw new UserChatProviderConfigurationError();
  }
};
