/**
 * C-88 server-only OpenAI-compatible image-generation adapter.
 *
 * This module has no default fetcher, environment lookup, filesystem, database
 * or process boundary. Every external boundary is injected and the response
 * is projected to the C-81 wire-safe ImageGenerationPort shape.
 */

import type {
  AssetMetadata,
  AssetRef,
  ImageGenerationContext,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageProviderManifest,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';

export interface OpenAIImageFetchResponse {
  readonly json?: () => unknown | Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
}

export type OpenAIImageFetcher = (
  endpoint: string,
  init: RequestInit,
) => OpenAIImageFetchResponse | Promise<OpenAIImageFetchResponse>;

export interface OpenAIImageAssetSinkInput {
  readonly bytes: Uint8Array;
  readonly metadata: AssetMetadata;
  readonly scope: RuntimeScope;
}

export type OpenAIImageAssetSinkResult =
  | AssetRef
  | string
  | {
      readonly asset: AssetRef | string;
    };

export type OpenAIImageAssetSink =
  | ((
      input: OpenAIImageAssetSinkInput,
    ) => OpenAIImageAssetSinkResult | Promise<OpenAIImageAssetSinkResult>)
  | {
      put: (
        input: OpenAIImageAssetSinkInput,
      ) => OpenAIImageAssetSinkResult | Promise<OpenAIImageAssetSinkResult>;
    };

export type OpenAIImageUriResolver = (
  scope: RuntimeScope,
  uri: string,
) => AssetRef | string | null | Promise<AssetRef | string | null>;

export type OpenAIImageReferenceReader = (
  scope: RuntimeScope,
  ref: string,
) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface OpenAIImageProviderOptions {
  readonly apiKey: string;
  readonly assetSink?: OpenAIImageAssetSink;
  readonly endpoint: string;
  readonly fetcher: OpenAIImageFetcher;
  readonly model?: string;
  readonly now?: () => number | string | Date;
  readonly providerId?: string;
  readonly readReferenceAsset?: OpenAIImageReferenceReader;
  readonly resolveAssetUri?: OpenAIImageUriResolver;
  /** Alias for callers that name the injected URI seam `uriResolver`. */
  readonly uriResolver?: OpenAIImageUriResolver;
}

export type OpenAIImageProviderErrorCode =
  | 'IMAGE_CANCELLED'
  | 'IMAGE_PAYLOAD_INVALID'
  | 'IMAGE_PROVIDER_REJECTED'
  | 'IMAGE_REQUEST_INVALID'
  | 'IMAGE_UNAVAILABLE';

export class OpenAIImageProviderError extends Error {
  constructor(
    public readonly code: OpenAIImageProviderErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OpenAIImageProviderError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const providerError = (
  code: OpenAIImageProviderErrorCode,
  message: string,
  path?: string,
): OpenAIImageProviderError => new OpenAIImageProviderError(code, message, path);

const invalid = (message: string, path?: string): OpenAIImageProviderError =>
  providerError('IMAGE_REQUEST_INVALID', message, path);

const payloadInvalid = (message: string, path?: string): OpenAIImageProviderError =>
  providerError('IMAGE_PAYLOAD_INVALID', message, path);

const unavailable = (message = 'Image provider is unavailable'): OpenAIImageProviderError =>
  providerError('IMAGE_UNAVAILABLE', message);

const cancelled = (): OpenAIImageProviderError =>
  providerError('IMAGE_CANCELLED', 'Image generation was cancelled', 'signal');

const cloneScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw invalid('scope.userId and scope.sessionId must be non-empty strings', 'scope');
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const scopeKey = (scope: RuntimeScope): string => JSON.stringify([scope.userId, scope.sessionId]);

const cloneBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

const cloneAsset = (asset: AssetRef): AssetRef => ({ ref: asset.ref });

const cloneMetadata = (metadata: AssetMetadata): AssetMetadata => ({
  ...metadata,
  ...(metadata.providerMetadata ? { providerMetadata: { ...metadata.providerMetadata } } : {}),
});

const cloneResult = (result: ImageGenerationResult): ImageGenerationResult => ({
  asset: cloneAsset(result.asset),
  index: result.index,
  metadata: cloneMetadata(result.metadata),
});

const normalizeNow = (now: () => number | string | Date): string => {
  const value = now();
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw payloadInvalid('now must return a valid time', 'now');
  return new Date(timestamp).toISOString();
};

const normalizeRef = (value: unknown, path: string): AssetRef => {
  const ref = typeof value === 'string' ? value : isRecord(value) ? value.ref : undefined;
  if (!nonEmptyString(ref)) throw payloadInvalid('asset resolver returned an invalid ref', path);
  const normalized = ref.trim();
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    /^[a-z]:[\\/]/iu.test(normalized) ||
    normalized.startsWith('file:')
  ) {
    throw payloadInvalid('asset ref must not be a local filesystem path', path);
  }
  return { ref: normalized };
};

const isAbortError = (error: unknown, signal?: AbortSignal): boolean =>
  signal?.aborted === true ||
  (error instanceof Error && error.name === 'AbortError') ||
  (isRecord(error) && error.name === 'AbortError');

const validateBase64 = (value: string): string => {
  const normalized = value.replaceAll(/\s/gu, '');
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/iu.test(normalized)
  ) {
    throw payloadInvalid('image b64_json must be valid base64', 'data.b64_json');
  }
  return normalized;
};

const decodeBase64 = (value: string): Uint8Array => {
  const normalized = validateBase64(value);
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
  } catch {
    throw payloadInvalid('image b64_json must be decodable base64', 'data.b64_json');
  }
};

const imageMimeType = (value: unknown, fallback = 'image/png'): string => {
  if (value === undefined) return fallback;
  if (!nonEmptyString(value) || !/^image\/[a-z\d.+-]+$/iu.test(value.trim())) {
    throw payloadInvalid('image mime type is invalid', 'data.mime_type');
  }
  return value.trim().toLowerCase();
};

const parseDataUrl = (value: string): { readonly bytes: Uint8Array; readonly mimeType: string } => {
  const match = /^data:(image\/[a-z\d.+-]+);base64,([a-z\d+/=\s]+)$/iu.exec(value);
  if (!match) throw payloadInvalid('image data URL is invalid', 'data.url');
  return { bytes: decodeBase64(match[2]), mimeType: imageMimeType(match[1]) };
};

const safeHttpsUrl = (value: unknown): string => {
  if (!nonEmptyString(value)) throw payloadInvalid('image url must be non-empty', 'data.url');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('unsafe protocol');
  } catch {
    throw payloadInvalid('image url must be an https URL', 'data.url');
  }
  return value.trim();
};

const requestCount = (request: ImageGenerationRequest): number => {
  const count = request.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw invalid('count must be a positive safe integer', 'count');
  }
  return count;
};

const validateRequest = (request: ImageGenerationRequest): number => {
  if (!isRecord(request) || !nonEmptyString(request.prompt)) {
    throw invalid('prompt must be a non-empty string', 'prompt');
  }
  if (request.size !== undefined && !nonEmptyString(request.size)) {
    throw invalid('size must be a non-empty string when provided', 'size');
  }
  if (request.quality !== undefined && !nonEmptyString(request.quality)) {
    throw invalid('quality must be a non-empty string when provided', 'quality');
  }
  if (request.idempotencyKey !== undefined && !nonEmptyString(request.idempotencyKey)) {
    throw invalid('idempotencyKey must be a non-empty string when provided', 'idempotencyKey');
  }
  if (
    request.referenceAssetRefs !== undefined &&
    (!Array.isArray(request.referenceAssetRefs) ||
      request.referenceAssetRefs.length > 4 ||
      request.referenceAssetRefs.some(
        (ref) =>
          !nonEmptyString(ref) || ref.length > 256 || /^(?:https?:|data:|file:|\/|\.)/iu.test(ref),
      ))
  )
    throw invalid('References must be owned raster asset ids', 'referenceAssetRefs');
  if (
    request.background !== undefined &&
    !['transparent', 'opaque', 'auto'].includes(request.background)
  )
    throw invalid('Invalid image background mode', 'background');
  return requestCount(request);
};

const dataUrlFromBase64 = (mimeType: string, base64: string): string =>
  `data:${mimeType};base64,${validateBase64(base64)}`;

const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const readResponseJson = async (response: OpenAIImageFetchResponse): Promise<unknown> => {
  if (!response || response.ok !== true || typeof response.json !== 'function') {
    throw payloadInvalid('provider response is not valid JSON', 'response');
  }
  try {
    return await response.json();
  } catch {
    throw payloadInvalid('provider response is not valid JSON', 'response');
  }
};

const sourceFromItem = (
  item: Record<string, unknown>,
):
  | { readonly bytes: Uint8Array; readonly mimeType: string; readonly source: 'data' }
  | { readonly mimeType: string; readonly source: 'url'; readonly uri: string } => {
  const b64 = item.b64_json;
  if (b64 !== undefined) {
    if (!nonEmptyString(b64)) throw payloadInvalid('image b64_json is missing', 'data.b64_json');
    const mimeType = imageMimeType(item.mime_type ?? item.mimeType);
    return { bytes: decodeBase64(b64), mimeType, source: 'data' };
  }

  const dataUrl = item.data_url;
  if (dataUrl !== undefined) {
    if (!nonEmptyString(dataUrl))
      throw payloadInvalid('image data URL is missing', 'data.data_url');
    const parsed = parseDataUrl(dataUrl);
    return { ...parsed, source: 'data' };
  }

  if (typeof item.url === 'string' && item.url.trim().toLowerCase().startsWith('data:')) {
    const parsed = parseDataUrl(item.url);
    return { ...parsed, source: 'data' };
  }
  const url = safeHttpsUrl(item.url);
  return { mimeType: imageMimeType(item.mime_type ?? item.mimeType), source: 'url', uri: url };
};

const manifestFor = (providerId: string): ImageProviderManifest => ({
  displayName: 'OpenAI-compatible image generation',
  providerId,
  supportedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  supportsIdempotency: true,
});

interface StoredAsset {
  readonly metadata: AssetMetadata;
  readonly scope: RuntimeScope;
}

/** OpenAI Images API-compatible C-81 ImageGenerationPort adapter. */
export class OpenAIImageGenerationPort implements ImageGenerationPort {
  readonly manifest: ImageProviderManifest;
  readonly model: string;
  readonly providerId: string;

  private readonly apiKey: string;
  private readonly assetSink?: OpenAIImageAssetSink;
  private readonly endpoint: string;
  private readonly fetcher: OpenAIImageFetcher;
  private readonly now: () => number | string | Date;
  private readonly resolveAssetUri?: OpenAIImageUriResolver;
  private readonly readReferenceAsset?: OpenAIImageReferenceReader;
  private readonly storedAssets = new Map<string, StoredAsset>();

  constructor(options: OpenAIImageProviderOptions) {
    if (!isRecord(options)) throw unavailable('OpenAI-compatible provider options are required');
    if (!nonEmptyString(options.endpoint) || !/^https?:\/\//iu.test(options.endpoint.trim())) {
      throw unavailable('OpenAI-compatible endpoint is unavailable');
    }
    if (!nonEmptyString(options.apiKey)) {
      throw unavailable('OpenAI-compatible provider credentials are unavailable');
    }
    if (typeof options.fetcher !== 'function') {
      throw unavailable('OpenAI-compatible fetcher is unavailable');
    }
    if (options.providerId !== undefined && !nonEmptyString(options.providerId)) {
      throw invalid('providerId must be non-empty when provided', 'providerId');
    }
    if (options.model !== undefined && !nonEmptyString(options.model)) {
      throw invalid('model must be non-empty when provided', 'model');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw invalid('now must be a function', 'now');
    }
    if (
      options.assetSink !== undefined &&
      !isRecord(options.assetSink) &&
      typeof options.assetSink !== 'function'
    ) {
      throw invalid('assetSink must be a function or put seam', 'assetSink');
    }
    const resolveAssetUri = options.resolveAssetUri ?? options.uriResolver;
    if (resolveAssetUri !== undefined && typeof resolveAssetUri !== 'function') {
      throw invalid('resolveAssetUri must be a function', 'resolveAssetUri');
    }

    this.apiKey = options.apiKey;
    this.assetSink = options.assetSink;
    this.endpoint = options.endpoint.trim();
    this.fetcher = options.fetcher;
    this.model = options.model?.trim() ?? 'gpt-image-2';
    this.now = options.now ?? (() => Date.now());
    this.providerId = options.providerId?.trim() ?? 'openai.image';
    this.resolveAssetUri = resolveAssetUri;
    this.readReferenceAsset = options.readReferenceAsset;
    this.manifest = manifestFor(this.providerId);
  }

  async generate(
    request: ImageGenerationRequest,
    context: ImageGenerationContext,
  ): Promise<ImageGenerationResult[]> {
    const count = validateRequest(request);
    const scope = cloneScope(context?.scope);
    const signal = context?.signal;
    if (signal?.aborted) throw cancelled();

    const fields = {
      model: this.model,
      n: count,
      prompt: request.prompt,
      ...(request.quality === undefined ? {} : { quality: request.quality }),
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.background === undefined ? {} : { background: request.background }),
    };
    let body: BodyInit = JSON.stringify(fields);
    let endpoint = this.endpoint;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;

    if (request.referenceAssetRefs?.length) {
      if (!this.readReferenceAsset || !/\/images\/generations$/u.test(endpoint))
        throw invalid('Reference-guided image generation is unavailable');
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
      for (const [index, ref] of request.referenceAssetRefs.entries()) {
        if (signal?.aborted) throw cancelled();
        const source = await this.readReferenceAsset(scope, ref);
        if (
          !source?.bytes.length ||
          source.bytes.length > 8 * 1024 * 1024 ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType)
        )
          throw invalid('A readable owned raster reference is required', 'referenceAssetRefs');
        const extension = source.mimeType === 'image/jpeg' ? 'jpg' : source.mimeType.split('/')[1];
        form.append(
          'image[]',
          new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }),
          `reference-${index}.${extension}`,
        );
      }
      if (signal?.aborted) throw cancelled();
      body = form;
      endpoint = endpoint.replace(/\/generations$/u, '/edits');
      delete headers['Content-Type']; // Let fetch supply the multipart boundary.
    }

    let response: OpenAIImageFetchResponse;
    try {
      response = await this.fetcher(endpoint, {
        body,
        headers,
        method: 'POST',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw cancelled();
      throw unavailable();
    }
    if (!response || typeof response.ok !== 'boolean')
      throw payloadInvalid('provider response is invalid');
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw providerError('IMAGE_PROVIDER_REJECTED', 'Image provider rejected the request');
      }
      throw unavailable();
    }
    if (signal?.aborted) throw cancelled();

    const payload = await readResponseJson(response);
    if (!isPlainRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
      throw payloadInvalid('provider response must contain a non-empty data array', 'data');
    }
    if (payload.data.length > count) {
      throw payloadInvalid('provider returned more images than requested', 'data');
    }

    const createdAt = normalizeNow(this.now);
    const results: ImageGenerationResult[] = [];
    for (const [index, candidate] of payload.data.entries()) {
      if (!isPlainRecord(candidate))
        throw payloadInvalid('provider image item must be an object', `data.${index}`);
      const source = sourceFromItem(candidate);
      const projected = await this.projectAsset(source, scope, createdAt, index, signal);
      results.push(projected);
    }
    return results.map(cloneResult);
  }

  async resolveAsset(scope: RuntimeScope, ref: AssetRef): Promise<AssetMetadata | null> {
    const normalizedScope = cloneScope(scope);
    const normalizedRef = normalizeRef(ref, 'ref');
    const stored = this.storedAssets.get(`${scopeKey(normalizedScope)}\u0000${normalizedRef.ref}`);
    return stored && sameScope(stored.scope, normalizedScope)
      ? cloneMetadata(stored.metadata)
      : null;
  }

  private async projectAsset(
    source:
      | { readonly bytes: Uint8Array; readonly mimeType: string; readonly source: 'data' }
      | { readonly mimeType: string; readonly source: 'url'; readonly uri: string },
    scope: RuntimeScope,
    createdAt: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult> {
    if (signal?.aborted) throw cancelled();
    const baseMetadata: AssetMetadata = {
      createdAt,
      mimeType: source.mimeType,
      ...(source.source === 'data' ? { sizeBytes: source.bytes.byteLength } : {}),
      providerMetadata: {
        model: this.model,
        provider: this.providerId,
        source: source.source,
      },
    };

    let asset: AssetRef;
    if (source.source === 'data' && this.assetSink) {
      try {
        const sinkResult =
          typeof this.assetSink === 'function'
            ? await this.assetSink({
                bytes: cloneBytes(source.bytes),
                metadata: cloneMetadata(baseMetadata),
                scope: { ...scope },
              })
            : await this.assetSink.put({
                bytes: cloneBytes(source.bytes),
                metadata: cloneMetadata(baseMetadata),
                scope: { ...scope },
              });
        const sinkAsset =
          isRecord(sinkResult) && 'asset' in sinkResult ? sinkResult.asset : sinkResult;
        asset = normalizeRef(sinkAsset, `data.${index}`);
      } catch (error) {
        if (error instanceof OpenAIImageProviderError) throw error;
        throw unavailable();
      }
    } else if (source.source === 'url' && this.resolveAssetUri) {
      try {
        const resolved = await this.resolveAssetUri(scope, source.uri);
        if (resolved === null)
          throw payloadInvalid('asset URI resolver returned no ref', `data.${index}`);
        asset = normalizeRef(resolved, `data.${index}`);
      } catch (error) {
        if (error instanceof OpenAIImageProviderError) throw error;
        throw unavailable();
      }
    } else {
      const ref =
        source.source === 'data'
          ? dataUrlFromBase64(source.mimeType, base64FromBytes(source.bytes))
          : source.uri;
      asset = normalizeRef(ref, `data.${index}`);
    }

    const result: ImageGenerationResult = { asset, index, metadata: baseMetadata };
    this.storedAssets.set(`${scopeKey(scope)}\u0000${asset.ref}`, {
      metadata: cloneMetadata(baseMetadata),
      scope: { ...scope },
    });
    return result;
  }
}

const sameScope = (left: RuntimeScope, right: RuntimeScope): boolean =>
  left.userId === right.userId && left.sessionId === right.sessionId;

export const createOpenAIImageGenerationPort = (
  options: OpenAIImageProviderOptions,
): OpenAIImageGenerationPort => new OpenAIImageGenerationPort(options);

export const createOpenAICompatibleImageGenerationPort = createOpenAIImageGenerationPort;
export const createOpenAIImageProvider = createOpenAIImageGenerationPort;
