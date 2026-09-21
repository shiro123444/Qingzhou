import { describe, expect, it, vi } from 'vitest';

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import type { GLMChatFetcher } from './multimodal-chat-provider-glm';
import {
  createProductionGLMMultimodalChatPort,
  DEFAULT_PRODUCTION_CHAT_BASE_URL,
  DEFAULT_PRODUCTION_CHAT_MODEL,
  DEFAULT_PRODUCTION_GLM_CHAT_BASE_URL,
  DEFAULT_PRODUCTION_GLM_CHAT_MODEL,
  loadProductionGLMChatProviderConfig,
  loadProductionGLMChatProviderOptions,
  normalizeGLMChatEndpoint,
  PRODUCTION_CHAT_ENV_KEYS,
  PRODUCTION_GLM_CHAT_ENV_KEYS,
  type ProductionGLMChatEnv,
  type ProductionGLMChatProviderDependencies,
} from './production-multimodal-chat-config';

const response = (payload: unknown): Awaited<ReturnType<GLMChatFetcher>> => ({
  json: async () => payload,
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
});

const defaultDependencies = (
  overrides: Partial<ProductionGLMChatProviderDependencies> = {},
): ProductionGLMChatProviderDependencies => ({
  fetcher: vi.fn<GLMChatFetcher>(async () => response({ choices: [] })),
  now: () => 1700000000000,
  ...overrides,
});

const env = (overrides: Record<string, string | undefined> = {}): ProductionGLMChatEnv => ({
  [PRODUCTION_GLM_CHAT_ENV_KEYS.apiKey]: 'test-secret-key-123',
  [PRODUCTION_GLM_CHAT_ENV_KEYS.baseUrl]: 'https://api.b.ai',
  [PRODUCTION_GLM_CHAT_ENV_KEYS.model]: 'glm-5.3-flash',
  ...overrides,
});

describe('Production GLM Chat Configuration Seam (C-106)', () => {
  describe('normalizeGLMChatEndpoint', () => {
    it('normalizes https://api.b.ai to /v1/chat/completions', () => {
      expect(normalizeGLMChatEndpoint('https://api.b.ai')).toBe(
        'https://api.b.ai/v1/chat/completions',
      );
    });

    it('normalizes trailing slash', () => {
      expect(normalizeGLMChatEndpoint('https://api.b.ai/')).toBe(
        'https://api.b.ai/v1/chat/completions',
      );
    });

    it('normalizes /v1 path', () => {
      expect(normalizeGLMChatEndpoint('https://api.b.ai/v1')).toBe(
        'https://api.b.ai/v1/chat/completions',
      );
      expect(normalizeGLMChatEndpoint('https://api.b.ai/v1/')).toBe(
        'https://api.b.ai/v1/chat/completions',
      );
    });

    it('accepts already-canonical path', () => {
      expect(normalizeGLMChatEndpoint('https://api.b.ai/v1/chat/completions')).toBe(
        'https://api.b.ai/v1/chat/completions',
      );
    });

    it('rewrites an /anthropic gateway alias to /v1/chat/completions', () => {
      expect(normalizeGLMChatEndpoint('https://api.deepseek.com/anthropic')).toBe(
        'https://api.deepseek.com/v1/chat/completions',
      );
      expect(normalizeGLMChatEndpoint('https://api.deepseek.com/anthropic/')).toBe(
        'https://api.deepseek.com/v1/chat/completions',
      );
    });

    it('rejects non-HTTPS URLs', () => {
      expect(() => normalizeGLMChatEndpoint('http://api.b.ai')).toThrowError(PresentationError);
    });

    it('rejects URLs with credentials, search params, or hashes', () => {
      expect(() => normalizeGLMChatEndpoint('https://user:pass@api.b.ai/v1')).toThrowError(
        PresentationError,
      );
      expect(() => normalizeGLMChatEndpoint('https://api.b.ai/v1?token=123')).toThrowError(
        PresentationError,
      );
      expect(() => normalizeGLMChatEndpoint('https://api.b.ai/v1#hash')).toThrowError(
        PresentationError,
      );
    });

    it('rejects disallowed subpaths', () => {
      expect(() => normalizeGLMChatEndpoint('https://api.b.ai/v2/chat')).toThrowError(
        PresentationError,
      );
    });
  });

  describe('loadProductionGLMChatProviderConfig', () => {
    it('defaults the provider-neutral model to Gemini when ANTHROPIC_MODEL is omitted', () => {
      const config = loadProductionGLMChatProviderConfig({
        [PRODUCTION_CHAT_ENV_KEYS.apiKey]: 'test-gemini-key',
      });

      expect(config.endpoint).toBe(`${DEFAULT_PRODUCTION_CHAT_BASE_URL}/v1/chat/completions`);
      expect(config.model).toBe(DEFAULT_PRODUCTION_CHAT_MODEL);
      expect(config.model).toBe('gemini-3.8-flash-high');
    });

    it('honors ANTHROPIC_MODEL for the active provider', () => {
      const config = loadProductionGLMChatProviderConfig({
        [PRODUCTION_CHAT_ENV_KEYS.apiKey]: 'test-deepseek-key',
        [PRODUCTION_CHAT_ENV_KEYS.baseUrl]: 'https://api.deepseek.com/anthropic',
        [PRODUCTION_CHAT_ENV_KEYS.model]: 'deepseek-v4.1-flash-expires-on-0910',
      });

      expect(config.endpoint).toBe('https://api.deepseek.com/v1/chat/completions');
      expect(config.model).toBe('deepseek-v4.1-flash-expires-on-0910');
    });

    it('ignores dependency and request model overrides for the active provider', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async (_endpoint, init) => {
        const body = JSON.parse(String(init.body)) as { model: string };
        return response({
          choices: [{ index: 0, message: { content: 'ok', role: 'assistant' } }],
          id: 'chat-model-lock',
          model: body.model,
        });
      });
      const port = createProductionGLMMultimodalChatPort({
        env: {
          [PRODUCTION_CHAT_ENV_KEYS.apiKey]: 'test-deepseek-key',
          [PRODUCTION_CHAT_ENV_KEYS.model]: 'deepseek-v4.1-flash-expires-on-0910',
        },
        fetcher,
        model: 'attempted-dependency-override',
      });

      await port.chat(
        {
          messages: [{ content: 'hello', role: 'user' }],
          model: 'attempted-request-override',
        },
        { scope: { sessionId: 's1', userId: 'u1' } },
      );

      expect(port.manifest.model).toBe('deepseek-v4.1-flash-expires-on-0910');
      expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).model).toBe(
        'deepseek-v4.1-flash-expires-on-0910',
      );
    });

    it('loads valid configuration with defaults', () => {
      const config = loadProductionGLMChatProviderConfig(
        env({
          [PRODUCTION_GLM_CHAT_ENV_KEYS.baseUrl]: undefined,
          [PRODUCTION_GLM_CHAT_ENV_KEYS.model]: undefined,
        }),
      );

      expect(config.apiKey).toBe('test-secret-key-123');
      expect(config.endpoint).toBe('https://api.b.ai/v1/chat/completions');
      expect(config.model).toBe(DEFAULT_PRODUCTION_GLM_CHAT_MODEL);
    });

    it('supports alternative env key fallbacks', () => {
      const config = loadProductionGLMChatProviderConfig({
        GLM_API_KEY: 'alt-key-456',
        GLM_BASE_URL: 'https://api.b.ai/v1',
        GLM_CHAT_MODEL: 'glm-5.3-flash',
      });

      expect(config.apiKey).toBe('alt-key-456');
      expect(config.endpoint).toBe('https://api.b.ai/v1/chat/completions');
      expect(config.model).toBe('glm-5.3-flash');
    });

    it('throws PROVIDER_UNAVAILABLE when API key is missing', () => {
      const missingKeyEnv = env({
        [PRODUCTION_GLM_CHAT_ENV_KEYS.apiKey]: undefined,
        GLM_API_KEY: undefined,
        LOBE_PRESENTATION_CHAT_API_KEY: undefined,
      });

      expect(() => loadProductionGLMChatProviderConfig(missingKeyEnv)).toThrowError(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    });

    it('throws PRESENTATION_INVALID when model is provided as empty string', () => {
      expect(() =>
        loadProductionGLMChatProviderConfig(env({ [PRODUCTION_GLM_CHAT_ENV_KEYS.model]: '   ' })),
      ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
    });
  });

  describe('createProductionGLMMultimodalChatPort', () => {
    it('creates a working port with injected dependencies', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({
          choices: [
            {
              index: 0,
              message: { content: 'Generated PPT structure', role: 'assistant' },
            },
          ],
          id: 'chat-prod-1',
        }),
      );

      const port = createProductionGLMMultimodalChatPort({
        env: env(),
        fetcher,
        now: () => 1700000000000,
      });

      expect(port.manifest.model).toBe('glm-5.3-flash');
      expect(port.manifest.supportsVision).toBe(true);

      const res = await port.chat(
        { messages: [{ content: 'Create PPT', role: 'user' }] },
        { scope: { sessionId: 's1', userId: 'u1' } },
      );

      expect(res.choices[0].message.content).toBe('Generated PPT structure');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('throws PROVIDER_UNAVAILABLE if fetcher is missing', () => {
      expect(() =>
        createProductionGLMMultimodalChatPort({
          env: env(),
        } as any),
      ).toThrowError(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
    });

    it('loads provider options using loadProductionGLMChatProviderOptions', () => {
      const deps = defaultDependencies();
      const options = loadProductionGLMChatProviderOptions(
        env({ [PRODUCTION_GLM_CHAT_ENV_KEYS.baseUrl]: DEFAULT_PRODUCTION_GLM_CHAT_BASE_URL }),
        deps,
      );

      expect(options.apiKey).toBe('test-secret-key-123');
      expect(options.endpoint).toBe('https://api.b.ai/v1/chat/completions');
      expect(options.model).toBe(DEFAULT_PRODUCTION_GLM_CHAT_MODEL);
      expect(options.fetcher).toBe(deps.fetcher);
    });

    it('honors dependencies.model override over env.BAI_CHAT_MODEL', () => {
      const deps = defaultDependencies({ model: 'glm-custom-override' });
      const port = createProductionGLMMultimodalChatPort({
        env: env({ [PRODUCTION_GLM_CHAT_ENV_KEYS.model]: 'glm-5.3-flash' }),
        ...deps,
      });

      expect(port.manifest.model).toBe('glm-custom-override');
    });

    it('throws PRESENTATION_INVALID when dependencies.model is empty', () => {
      expect(() =>
        loadProductionGLMChatProviderOptions(env(), {
          fetcher: vi.fn(),
          model: '   ',
        }),
      ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_INVALID' }));
    });

    it('does not invoke fetcher during assembly stage', () => {
      const fetcher = vi.fn<GLMChatFetcher>();
      createProductionGLMMultimodalChatPort({
        env: env(),
        fetcher,
      });

      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});
