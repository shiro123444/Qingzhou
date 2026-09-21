/**
 * C-98 server-only production configuration seam for the C-88
 * OpenAI-compatible image provider.
 *
 * Configuration is always supplied as an explicit env-like record. This
 * module never reads process.env, performs network I/O, starts a process, or
 * invents an authenticated scope. Scope is supplied later by the caller to
 * ImageGenerationPort.generate().
 */

import { PresentationError } from '../../../../packages/cordis-kernel/src/presentation';
import type {
  OpenAIImageAssetSink,
  OpenAIImageFetcher,
  OpenAIImageProviderOptions,
  OpenAIImageReferenceReader,
  OpenAIImageUriResolver,
} from './image-provider-openai';
import { createOpenAIImageGenerationPort } from './image-provider-openai';

export type ProductionImageEnv = Readonly<Record<string, string | undefined>>;

export const PRODUCTION_IMAGE_ENV_KEYS = {
  apiKey: 'OPENAI_API_KEY',
  baseUrl: 'OPENAI_BASE_URL',
  model: 'OPENAI_IMAGE_MODEL',
} as const;

/** Alias using the provider name for callers that prefer an explicit prefix. */
export const PRODUCTION_OPENAI_IMAGE_ENV_KEYS = PRODUCTION_IMAGE_ENV_KEYS;

export const DEFAULT_PRODUCTION_IMAGE_MODEL = 'gpt-image-2';

export interface ProductionOpenAIImageProviderConfig {
  /** Internal credential passed only to the injected C-88 adapter. */
  readonly apiKey: string;
  /** Canonical `.../v1/images/generations` endpoint. */
  readonly endpoint: string;
  readonly model: string;
}

export interface ProductionOpenAIImageProviderDependencies {
  readonly assetSink?: OpenAIImageAssetSink;
  readonly fetcher: OpenAIImageFetcher;
  readonly now?: NonNullable<OpenAIImageProviderOptions['now']>;
  readonly providerId?: string;
  readonly readReferenceAsset?: OpenAIImageReferenceReader;
  readonly resolveAssetUri?: OpenAIImageUriResolver;
  readonly uriResolver?: OpenAIImageUriResolver;
}

export interface ProductionOpenAIImageCompositionOptions extends ProductionOpenAIImageProviderDependencies {
  readonly env: ProductionImageEnv;
}

export type ProductionOpenAIImageProviderOptions = OpenAIImageProviderOptions;

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
 * Normalizes an OpenAI-compatible base URL to one and only one generations
 * path. Only the host root, `/v1`, or the already-complete path is accepted;
 * this prevents silently targeting an unexpected deployment path.
 */
export const normalizeOpenAIImageEndpoint = (value: unknown): string => {
  if (!nonEmptyString(value)) throw invalid('OPENAI_BASE_URL must be a URL', 'OPENAI_BASE_URL');

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalid('OPENAI_BASE_URL must be a valid HTTPS URL', 'OPENAI_BASE_URL');
  }

  const pathname = parsed.pathname.replace(/\/+$/u, '');
  const allowedPath =
    pathname === '' || pathname === '/v1' || pathname === '/v1/images/generations';
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !allowedPath
  ) {
    throw invalid('OPENAI_BASE_URL must be a valid HTTPS base URL', 'OPENAI_BASE_URL');
  }

  parsed.pathname = '/v1/images/generations';
  return parsed.toString();
};

/** Load and validate only the explicit deployment values. */
export const loadProductionOpenAIImageProviderConfig = (
  env: ProductionImageEnv = {},
): ProductionOpenAIImageProviderConfig => {
  const baseUrl = readEnv(env, PRODUCTION_IMAGE_ENV_KEYS.baseUrl);
  if (!baseUrl) throw unavailable('OpenAI image provider base URL is not configured');

  const apiKey = readEnv(env, PRODUCTION_IMAGE_ENV_KEYS.apiKey);
  if (!apiKey) throw unavailable('OpenAI image provider credentials are not configured');

  const modelValue = readEnv(env, PRODUCTION_IMAGE_ENV_KEYS.model);
  if (modelValue !== undefined && !nonEmptyString(modelValue)) {
    throw invalid('OPENAI_IMAGE_MODEL must be non-empty when provided', 'OPENAI_IMAGE_MODEL');
  }

  return Object.freeze({
    apiKey,
    endpoint: normalizeOpenAIImageEndpoint(baseUrl),
    model: modelValue ?? DEFAULT_PRODUCTION_IMAGE_MODEL,
  });
};

const isAssetSink = (value: unknown): value is OpenAIImageAssetSink =>
  typeof value === 'function' || (isRecord(value) && typeof value.put === 'function');

function validateDependencies(
  value: unknown,
): asserts value is ProductionOpenAIImageProviderDependencies {
  if (!isPlainRecord(value)) throw unavailable('OpenAI image provider dependencies are required');
  if (typeof value.fetcher !== 'function') {
    throw unavailable('OpenAI image provider fetcher is not configured', 'fetcher');
  }
  if (value.assetSink !== undefined && !isAssetSink(value.assetSink)) {
    throw invalid('assetSink must be a function or put seam', 'assetSink');
  }
  if (value.now !== undefined && typeof value.now !== 'function') {
    throw invalid('now must be a function', 'now');
  }
  if (value.providerId !== undefined && !nonEmptyString(value.providerId)) {
    throw invalid('providerId must be non-empty when provided', 'providerId');
  }
  if (value.resolveAssetUri !== undefined && typeof value.resolveAssetUri !== 'function') {
    throw invalid('resolveAssetUri must be a function', 'resolveAssetUri');
  }
  if (value.uriResolver !== undefined && typeof value.uriResolver !== 'function') {
    throw invalid('uriResolver must be a function', 'uriResolver');
  }
  if (value.resolveAssetUri !== undefined && value.uriResolver !== undefined) {
    throw invalid('resolveAssetUri and uriResolver are mutually exclusive', 'resolveAssetUri');
  }
}

/**
 * Combines the explicit env-like record and injected execution/storage seams
 * into the exact C-88 adapter options. The returned object is internal
 * configuration; callers must not serialize it because it contains the key.
 */
export const loadProductionOpenAIImageProviderOptions = (
  env: ProductionImageEnv,
  dependencies: ProductionOpenAIImageProviderDependencies,
): OpenAIImageProviderOptions => {
  const config = loadProductionOpenAIImageProviderConfig(env);
  validateDependencies(dependencies);

  return Object.freeze({
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    fetcher: dependencies.fetcher,
    ...(dependencies.readReferenceAsset
      ? { readReferenceAsset: dependencies.readReferenceAsset }
      : {}),
    ...(dependencies.assetSink === undefined ? {} : { assetSink: dependencies.assetSink }),
    model: config.model,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.providerId === undefined
      ? {}
      : { providerId: dependencies.providerId.trim() }),
    ...(dependencies.resolveAssetUri === undefined
      ? dependencies.uriResolver === undefined
        ? {}
        : { uriResolver: dependencies.uriResolver }
      : { resolveAssetUri: dependencies.resolveAssetUri }),
  });
};

const isCompositionOptions = (value: unknown): value is ProductionOpenAIImageCompositionOptions =>
  isPlainRecord(value) && 'env' in value && 'fetcher' in value;

/**
 * Compose the C-98 configuration with the unchanged C-88 adapter. No fetcher
 * call, asset write, clock read, network request, process spawn, or scope
 * lookup occurs until the caller invokes the returned port's generate method.
 */
export function createProductionOpenAIImageGenerationPort(
  env: ProductionImageEnv,
  dependencies: ProductionOpenAIImageProviderDependencies,
): ReturnType<typeof createOpenAIImageGenerationPort>;
export function createProductionOpenAIImageGenerationPort(
  options: ProductionOpenAIImageCompositionOptions,
): ReturnType<typeof createOpenAIImageGenerationPort>;
export function createProductionOpenAIImageGenerationPort(
  envOrOptions: ProductionImageEnv | ProductionOpenAIImageCompositionOptions,
  dependencies?: ProductionOpenAIImageProviderDependencies,
): ReturnType<typeof createOpenAIImageGenerationPort> {
  if (dependencies === undefined && isCompositionOptions(envOrOptions)) {
    const options = envOrOptions;
    return createOpenAIImageGenerationPort(
      loadProductionOpenAIImageProviderOptions(options.env, options),
    );
  }
  if (dependencies === undefined) {
    throw unavailable('OpenAI image provider dependencies are required');
  }
  return createOpenAIImageGenerationPort(
    loadProductionOpenAIImageProviderOptions(
      envOrOptions as unknown as ProductionImageEnv,
      dependencies,
    ),
  );
}

export const createProductionOpenAICompatibleImageGenerationPort =
  createProductionOpenAIImageGenerationPort;
export const createProductionImageGenerationPort = createProductionOpenAIImageGenerationPort;
export const createProductionOpenAIImageProvider = createProductionOpenAIImageGenerationPort;
export const createProductionImageProvider = createProductionOpenAIImageGenerationPort;
export const loadProductionImageProviderConfig = loadProductionOpenAIImageProviderConfig;
export const loadProductionImageProviderOptions = loadProductionOpenAIImageProviderOptions;
export const normalizeProductionImageEndpoint = normalizeOpenAIImageEndpoint;
