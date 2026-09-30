// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiProviderModel } from '@/database/models/aiProvider';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { type LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { AgentService } from '@/server/services/agent';

import { resolveUserChatProvider, UserChatProviderConfigurationError } from './index';

const mocks = vi.hoisted(() => ({
  getAgentConfig: vi.fn(),
  getAiProviderById: vi.fn(),
  getAiProviderModelList: vi.fn(),
  getLLMConfig: vi.fn(() => ({ API_KEY_SELECT_MODE: 'turn' }) as Record<string, string>),
  getServerGlobalConfig: vi.fn(),
}));

// Mock I/O boundaries, but exercise the real ModelRuntime credential/SDK helpers.
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: vi.fn(function () {
    return { getAiProviderById: mocks.getAiProviderById };
  }),
}));
vi.mock('@/database/repositories/aiInfra', () => ({
  AiInfraRepos: vi.fn(function () {
    return { getAiProviderModelList: mocks.getAiProviderModelList };
  }),
}));
vi.mock('@/server/services/agent', () => ({
  AgentService: vi.fn(function () {
    return { getAgentConfig: mocks.getAgentConfig };
  }),
}));
vi.mock('@/envs/llm', () => ({ getLLMConfig: mocks.getLLMConfig }));
vi.mock('@/server/globalConfig', () => ({
  getServerGlobalConfig: mocks.getServerGlobalConfig,
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));

const db = {} as LobeChatDatabase;
const userId = 'user-one';
const serverProviders = { openai: { enabled: true } };
const selection = { model: 'user-model', provider: 'tini' };
const providerConfig = {
  enabled: true,
  id: 'tini',
  keyVaults: { apiKey: 'user-secret', baseURL: 'https://tini.example/v1' },
  settings: { sdkType: 'openai' },
};
const modelMetadata = {
  abilities: { vision: true },
  enabled: true,
  id: 'user-model',
  type: 'chat',
};

describe('resolveUserChatProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentConfig.mockResolvedValue(selection);
    mocks.getAiProviderById.mockResolvedValue(providerConfig);
    mocks.getAiProviderModelList.mockResolvedValue([modelMetadata]);
    mocks.getLLMConfig.mockReturnValue({
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'server-secret',
      TINI_API_KEY: 'unused-tini-secret',
    });
    mocks.getServerGlobalConfig.mockResolvedValue({ aiProvider: serverProviders });
    vi.stubEnv('OPENAI_PROXY_URL', 'https://server.example/v1');
    vi.stubEnv('TINI_PROXY_URL', 'https://unused-tini.example/v1');
    vi.stubEnv('API_KEY_SELECT_MODE', 'turn');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the inbox selection and decryptor with user-scoped merged model metadata', async () => {
    await expect(resolveUserChatProvider(db, userId)).resolves.toEqual({
      apiKey: 'user-secret',
      baseURL: 'https://tini.example/v1',
      model: 'user-model',
      provider: 'tini',
      supportsVision: true,
    });
    expect(AgentService).toHaveBeenCalledWith(db, userId);
    expect(mocks.getAgentConfig).toHaveBeenCalledWith('inbox');
    expect(AiProviderModel).toHaveBeenCalledWith(db, userId);
    expect(mocks.getAiProviderById).toHaveBeenCalledWith(
      'tini',
      KeyVaultsGateKeeper.getUserKeyVaults,
    );
    expect(AiInfraRepos).toHaveBeenCalledWith(db, userId, serverProviders);
    expect(mocks.getAiProviderModelList).toHaveBeenCalledWith('tini');
  });

  it('defaults a custom provider SDK to openai, using runtime SDK environment precedence', async () => {
    mocks.getAiProviderById.mockResolvedValue({ ...providerConfig, keyVaults: {}, settings: {} });
    await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
      apiKey: 'server-secret',
      baseURL: 'https://server.example/v1',
    });
  });

  it('keeps user key with server endpoint, and server key with user endpoint', async () => {
    mocks.getAiProviderById.mockResolvedValueOnce({
      ...providerConfig,
      keyVaults: { apiKey: 'user-secret' },
    });
    await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
      apiKey: 'user-secret',
      baseURL: 'https://server.example/v1',
    });
    mocks.getAiProviderById.mockResolvedValueOnce({
      ...providerConfig,
      keyVaults: { baseURL: 'https://tini.example/v1' },
    });
    await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
      apiKey: 'server-secret',
      baseURL: 'https://tini.example/v1',
    });
  });

  it('uses the OpenAI SDK default endpoint when neither user nor server provides one', async () => {
    vi.stubEnv('OPENAI_PROXY_URL', '');
    mocks.getAiProviderById.mockResolvedValue({ ...providerConfig, keyVaults: {} });
    await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
      baseURL: 'https://api.openai.com/v1',
    });
  });

  it('selects one API key through the existing runtime key manager', async () => {
    mocks.getAiProviderById.mockResolvedValue({
      ...providerConfig,
      keyVaults: { ...providerConfig.keyVaults, apiKey: 'first-secret,second-secret' },
    });
    const first = await resolveUserChatProvider(db, userId);
    const second = await resolveUserChatProvider(db, userId);
    expect(new Set([first.apiKey, second.apiKey])).toEqual(
      new Set(['first-secret', 'second-secret']),
    );
  });

  it.each(['anthropic', 'google', 'azure', 'bedrock', 'unknown-sdk'])(
    'rejects custom %s SDK before resolving credentials',
    async (sdkType) => {
      mocks.getAiProviderById.mockResolvedValue({
        ...providerConfig,
        settings: { sdkType },
      });
      await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
        UserChatProviderConfigurationError,
      );
      expect(mocks.getLLMConfig).not.toHaveBeenCalled();
    },
  );

  it.each(['anthropic', 'google', 'azure', 'nexus'])(
    'does not let settings.sdkType disguise builtin %s credentials as OpenAI',
    async (provider) => {
      mocks.getAgentConfig.mockResolvedValue({ ...selection, provider });
      await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
        UserChatProviderConfigurationError,
      );
      expect(mocks.getLLMConfig).not.toHaveBeenCalled();
    },
  );

  it('retains the builtin OpenAI SDK even if settings contain a different SDK', async () => {
    mocks.getAgentConfig.mockResolvedValue({ ...selection, provider: 'openai' });
    mocks.getAiProviderById.mockResolvedValue({
      ...providerConfig,
      settings: { sdkType: 'anthropic' },
    });
    await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
      provider: 'openai',
    });
  });

  it.each([undefined, { ...providerConfig, enabled: false }])(
    'rejects missing or explicitly disabled providers',
    async (config) => {
      mocks.getAiProviderById.mockResolvedValue(config);
      await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
        UserChatProviderConfigurationError,
      );
      expect(mocks.getLLMConfig).not.toHaveBeenCalled();
    },
  );

  it.each([
    { models: [] },
    { models: [{ ...modelMetadata, enabled: false }] },
    { models: [{ ...modelMetadata, enabled: undefined }] },
    { models: [{ ...modelMetadata, type: 'image' }] },
    { models: [{ ...modelMetadata, id: 'another-model' }] },
  ])('rejects models not present as enabled chat models: $models', async ({ models }) => {
    mocks.getAiProviderModelList.mockResolvedValue(models);
    await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
      UserChatProviderConfigurationError,
    );
    expect(mocks.getLLMConfig).not.toHaveBeenCalled();
  });

  it.each([{}, { vision: false }, undefined])(
    'does not infer vision from a model name when abilities are %j',
    async (abilities) => {
      mocks.getAgentConfig.mockResolvedValue({ ...selection, model: 'gemini-vision-gpt-4o' });
      mocks.getAiProviderModelList.mockResolvedValue([
        { ...modelMetadata, abilities, id: 'gemini-vision-gpt-4o' },
      ]);
      await expect(resolveUserChatProvider(db, userId)).resolves.toMatchObject({
        supportsVision: false,
      });
    },
  );

  it.each([null, { provider: 'tini' }, { model: 'user-model' }])(
    'rejects a missing or incomplete inbox selection: %j',
    async (agent) => {
      mocks.getAgentConfig.mockResolvedValue(agent);
      await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
        UserChatProviderConfigurationError,
      );
      expect(mocks.getAiProviderById).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty user ID before DB access', async () => {
    await expect(resolveUserChatProvider(db, ' ')).rejects.toBeInstanceOf(
      UserChatProviderConfigurationError,
    );
    expect(AgentService).not.toHaveBeenCalled();
  });

  it('rejects missing credentials rather than falling back to Anthropic environment keys', async () => {
    mocks.getLLMConfig.mockReturnValue({ ANTHROPIC_API_KEY: 'anthropic-secret' });
    mocks.getAiProviderById.mockResolvedValue({ ...providerConfig, keyVaults: {} });
    await expect(resolveUserChatProvider(db, userId)).rejects.toBeInstanceOf(
      UserChatProviderConfigurationError,
    );
  });

  it.each(['not-a-url', 'file:///tmp/provider', 'https://user:secret@tini.example/v1'])(
    'rejects an invalid or credential-bearing endpoint without leaking it',
    async (baseURL) => {
      mocks.getAiProviderById.mockResolvedValue({
        ...providerConfig,
        keyVaults: { ...providerConfig.keyVaults, baseURL },
      });
      await expect(resolveUserChatProvider(db, userId)).rejects.toThrow(
        new UserChatProviderConfigurationError(),
      );
    },
  );

  it.each([
    'getAgentConfig',
    'getAiProviderById',
    'getAiProviderModelList',
    'getServerGlobalConfig',
    'getLLMConfig',
  ] as const)('sanitizes %s failures without logs or secret-bearing causes', async (operation) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks[operation].mockImplementation(() => {
      throw new Error('secret DB key: user-secret');
    });
    const error = await resolveUserChatProvider(db, userId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UserChatProviderConfigurationError);
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('user-secret');
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
    expect(infoLog).not.toHaveBeenCalled();
  });

  it('resolves each user and current inbox afresh without caching credentials or model selection', async () => {
    const first = await resolveUserChatProvider(db, userId);
    mocks.getAgentConfig.mockResolvedValue({ model: 'second-model', provider: 'second-provider' });
    mocks.getAiProviderById.mockResolvedValue({
      ...providerConfig,
      keyVaults: { apiKey: 'second-secret', baseURL: 'https://second.example/v1' },
    });
    mocks.getAiProviderModelList.mockResolvedValue([
      { ...modelMetadata, abilities: { vision: false }, id: 'second-model' },
    ]);
    const second = await resolveUserChatProvider(db, 'user-two');
    expect(first.apiKey).toBe('user-secret');
    expect(second).toEqual({
      apiKey: 'second-secret',
      baseURL: 'https://second.example/v1',
      model: 'second-model',
      provider: 'second-provider',
      supportsVision: false,
    });
    expect(AgentService).toHaveBeenLastCalledWith(db, 'user-two');
    expect(AiProviderModel).toHaveBeenLastCalledWith(db, 'user-two');
    expect(AiInfraRepos).toHaveBeenLastCalledWith(db, 'user-two', serverProviders);
    expect(mocks.getAgentConfig).toHaveBeenCalledTimes(2);
  });
});
