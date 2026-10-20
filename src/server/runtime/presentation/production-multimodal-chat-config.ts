/**
 * Server-only production configuration seam for the OpenAI-compatible
 * multimodal chat provider used by the presentation pipeline.
 *
 * Configuration is always supplied as an explicit env-like record. This module
 * never reads process.env, request headers, a database, or starts a process.
 * Scope is supplied later by the caller on every chat invocation.
 */

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import {
  createGLMMultimodalChatPort,
  DEFAULT_MULTIMODAL_CHAT_MODEL,
  type GLMChatFetcher,
  type GLMChatProviderOptions,
  type GLMMultimodalChatPort,
} from './multimodal-chat-provider-glm';

export type ProductionGLMChatEnv = Readonly<Record<string, string | undefined>>;

export const PRODUCTION_GLM_CHAT_ENV_KEYS = {
  apiKey: 'BAI_API_KEY',
  baseUrl: 'BAI_BASE_URL',
  model: 'BAI_CHAT_MODEL',
} as const;

/** Provider-neutral aliases used by the production application. */
export const PRODUCTION_CHAT_ENV_KEYS = {
  apiKey: 'ANTHROPIC_AUTH_TOKEN',
  baseUrl: 'ANTHROPIC_BASE_URL',
  model: 'ANTHROPIC_MODEL',
} as const;

export const DEFAULT_PRODUCTION_CHAT_BASE_URL = 'https://cli.tinimodel.com';
export const DEFAULT_PRODUCTION_CHAT_MODEL = DEFAULT_MULTIMODAL_CHAT_MODEL;

/** @deprecated Kept as a source-compatibility alias; GLM is no longer active. */
export const DEFAULT_PRODUCTION_GLM_CHAT_BASE_URL = 'https://api.b.ai';
/** @deprecated Kept as a source-compatibility alias; GLM is no longer active. */
export const DEFAULT_PRODUCTION_GLM_CHAT_MODEL = 'glm-5.3-flash';

export interface ProductionGLMChatProviderConfig {
  /** Internal credential passed only to the injected adapter. */
  readonly apiKey: string;
  /** Canonical `.../v1/chat/completions` endpoint. */
  readonly endpoint: string;
  readonly model: string;
}

export interface ProductionGLMChatProviderDependencies {
  readonly fetcher: GLMChatFetcher;
  readonly model?: string;
  readonly now?: NonNullable<GLMChatProviderOptions['now']>;
  readonly providerId?: string;
}

export interface ProductionGLMChatCompositionOptions extends ProductionGLMChatProviderDependencies {
  readonly env: ProductionGLMChatEnv;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const invalid = (message: string, path: string): PresentationError =>
  new PresentationError('PRESENTATION_INVALID', message, { path });

const unavailable = (message: string, path?: string): PresentationError =>
  new PresentationError('PROVIDER_UNAVAILABLE', message, path ? { path } : {});

const readEnv = (env: unknown, key: string): string | undefined => {
  if (!isPlainRecord(env)) throw invalid('env must be a plain object', 'env');
  const value = env[key];
  if (value === undefined) return;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`, key);
  return value.trim();
};

/**
 * Normalizes an OpenAI-compatible chat base URL to canonical `/v1/chat/completions`.
 * Only the host root, `/v1`, or the complete `/v1/chat/completions` is accepted.
 */
export const normalizeGLMChatEndpoint = (value: unknown): string => {
  if (!nonEmptyString(value)) throw invalid('BAI_BASE_URL must be a URL', 'BAI_BASE_URL');

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalid('BAI_BASE_URL must be a valid HTTPS URL', 'BAI_BASE_URL');
  }

  const pathname = parsed.pathname.replace(/\/+$/u, '');
  // `/anthropic` is accepted as a gateway alias and rewritten to the OpenAI
  // chat-completions path this adapter actually calls.
  const allowedPath =
    pathname === '' ||
    pathname === '/v1' ||
    pathname === '/v1/chat/completions' ||
    pathname === '/anthropic';
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !allowedPath
  ) {
    throw invalid('BAI_BASE_URL must be a valid HTTPS base URL', 'BAI_BASE_URL');
  }

  parsed.pathname = '/v1/chat/completions';
  return parsed.toString();
};

/** Load and validate only the explicit deployment values for GLM chat. */
export const loadProductionGLMChatProviderConfig = (
  env: ProductionGLMChatEnv = {},
): ProductionGLMChatProviderConfig => {
  const providerNeutralKey = readEnv(env, PRODUCTION_CHAT_ENV_KEYS.apiKey);
  const legacyKey =
    readEnv(env, PRODUCTION_GLM_CHAT_ENV_KEYS.apiKey) ??
    readEnv(env, 'GLM_API_KEY') ??
    readEnv(env, 'LOBE_PRESENTATION_CHAT_API_KEY');
  const legacyMode = providerNeutralKey === undefined && legacyKey !== undefined;
  const apiKey = providerNeutralKey ?? legacyKey;
  if (!apiKey) throw unavailable('GLM multimodal chat provider credentials are not configured');

  const rawBaseUrl =
    readEnv(env, PRODUCTION_CHAT_ENV_KEYS.baseUrl) ??
    readEnv(env, PRODUCTION_GLM_CHAT_ENV_KEYS.baseUrl) ??
    readEnv(env, 'GLM_BASE_URL') ??
    readEnv(env, 'LOBE_PRESENTATION_CHAT_BASE_URL') ??
    (legacyMode ? DEFAULT_PRODUCTION_GLM_CHAT_BASE_URL : DEFAULT_PRODUCTION_CHAT_BASE_URL);

  const endpoint = normalizeGLMChatEndpoint(rawBaseUrl);

  // Active provider uses ANTHROPIC_MODEL when set; otherwise the default
  // Gemini model. Request/dependency overrides stay locked in this mode.
  const modelValue = legacyMode
    ? (readEnv(env, PRODUCTION_GLM_CHAT_ENV_KEYS.model) ??
      readEnv(env, 'GLM_CHAT_MODEL') ??
      readEnv(env, 'LOBE_PRESENTATION_CHAT_MODEL'))
    : readEnv(env, PRODUCTION_CHAT_ENV_KEYS.model);

  if (modelValue !== undefined && !nonEmptyString(modelValue)) {
    throw invalid('BAI_CHAT_MODEL must be non-empty when provided', 'BAI_CHAT_MODEL');
  }

  return Object.freeze({
    apiKey,
    endpoint,
    model:
      modelValue ??
      (legacyMode ? DEFAULT_PRODUCTION_GLM_CHAT_MODEL : DEFAULT_PRODUCTION_CHAT_MODEL),
  });
};

function validateDependencies(
  value: unknown,
): asserts value is ProductionGLMChatProviderDependencies {
  if (!isPlainRecord(value)) throw unavailable('GLM chat provider dependencies are required');
  if (typeof value.fetcher !== 'function') {
    throw unavailable('GLM chat provider fetcher is not configured', 'fetcher');
  }
  if (value.model !== undefined && !nonEmptyString(value.model)) {
    throw invalid('model must be a non-empty string when provided', 'model');
  }
  if (value.providerId !== undefined && !nonEmptyString(value.providerId)) {
    throw invalid('providerId must be a non-empty string when provided', 'providerId');
  }
  if (value.now !== undefined && typeof value.now !== 'function') {
    throw invalid('now must be a function when provided', 'now');
  }
}

export const loadProductionGLMChatProviderOptions = (
  env: ProductionGLMChatEnv = {},
  dependencies?: ProductionGLMChatProviderDependencies,
): GLMChatProviderOptions => {
  const config = loadProductionGLMChatProviderConfig(env);
  if (dependencies !== undefined) validateDependencies(dependencies);

  const activeProviderMode = readEnv(env, PRODUCTION_CHAT_ENV_KEYS.apiKey) !== undefined;
  let model = config.model;
  if (!activeProviderMode && dependencies?.model !== undefined) {
    if (!nonEmptyString(dependencies.model)) {
      throw invalid('model must be a non-empty string when provided', 'model');
    }
    model = dependencies.model.trim();
  }

  return Object.freeze({
    allowRequestModelOverride: !activeProviderMode,
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    fetcher: dependencies?.fetcher as GLMChatFetcher,
    model,
    ...(dependencies?.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies?.providerId === undefined
      ? {}
      : { providerId: dependencies.providerId.trim() }),
  });
};

export const createProductionGLMMultimodalChatPort = (
  options: ProductionGLMChatCompositionOptions,
): GLMMultimodalChatPort => {
  if (!isPlainRecord(options)) throw unavailable('Options must be an object');
  const { env, ...dependencies } = options;
  validateDependencies(dependencies);
  const providerOptions = loadProductionGLMChatProviderOptions(env, dependencies);
  return createGLMMultimodalChatPort(providerOptions);
};

/** Provider-neutral production entry points. */
export const createProductionMultimodalChatPort = createProductionGLMMultimodalChatPort;
export const loadProductionMultimodalChatProviderConfig = loadProductionGLMChatProviderConfig;
export const loadProductionMultimodalChatProviderOptions = loadProductionGLMChatProviderOptions;
export const normalizeMultimodalChatEndpoint = normalizeGLMChatEndpoint;

export type ProductionMultimodalChatEnv = ProductionGLMChatEnv;
export type ProductionMultimodalChatProviderConfig = ProductionGLMChatProviderConfig;
export type ProductionMultimodalChatProviderDependencies = ProductionGLMChatProviderDependencies;
export type ProductionMultimodalChatCompositionOptions = ProductionGLMChatCompositionOptions;
