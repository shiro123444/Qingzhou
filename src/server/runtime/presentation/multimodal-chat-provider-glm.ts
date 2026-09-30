import { createHash } from 'node:crypto';

/**
 * Server-only OpenAI-compatible multimodal chat adapter.
 *
 * Provides a vendor-neutral multimodal completion port for PPT agent dialogue
 * and outline generation. Supports text + server-resolved image references (URL).
 * Strictly forbids client-side data URLs, file URIs, local paths, and base64.
 *
 * No process.env, filesystem, database or real network is touched directly.
 * All external boundaries (fetcher, clock, apiKey, endpoint) are explicitly injected.
 */
import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';

export const DEFAULT_MULTIMODAL_CHAT_MODEL = 'gemini-3.8-flash-high';

export interface GLMChatFetchResponse {
  readonly json?: () => unknown | Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
  readonly text?: () => string | Promise<string>;
}

export type GLMChatFetcher = (
  endpoint: string,
  init: RequestInit,
) => GLMChatFetchResponse | Promise<GLMChatFetchResponse>;

export interface GLMImageContentPart {
  readonly image_url: {
    readonly detail?: 'auto' | 'high' | 'low';
    readonly url: string;
  };
  readonly type: 'image_url';
}

export interface GLMTextContentPart {
  readonly text: string;
  readonly type: 'text';
}

export type GLMChatContentPart = GLMTextContentPart | GLMImageContentPart;

export interface GLMChatMessage {
  readonly content: string | readonly GLMChatContentPart[];
  readonly role: 'assistant' | 'system' | 'user';
}

export interface GLMChatRequest {
  readonly idempotencyKey?: string;
  readonly max_tokens?: number;
  readonly messages: readonly GLMChatMessage[];
  readonly model?: string;
  readonly response_format?: { readonly type: 'json_object' | 'text' };
  readonly temperature?: number;
}

export interface GLMChatChoice {
  readonly finish_reason?: string;
  readonly index: number;
  readonly message: {
    readonly content: string;
    readonly reasoning_content?: string;
    readonly role: 'assistant';
  };
}

export interface GLMChatUsage {
  readonly completion_tokens?: number;
  readonly prompt_tokens?: number;
  readonly total_tokens?: number;
}

export interface GLMChatResult {
  readonly choices: readonly GLMChatChoice[];
  readonly created: number;
  readonly id: string;
  readonly model: string;
  readonly usage?: GLMChatUsage;
}

export interface GLMChatContext {
  readonly idempotencyKey?: string;
  readonly onRetry?: (event: { attempt: number; maxAttempts: number }) => void;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceId?: string;
  /** Process-local permission for images read from the authenticated asset store. Never wire input. */
  readonly trustedImages?: GLMTrustedChatImages;
}

export interface GLMServerImageInput {
  readonly base64: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

declare const trustedImagesBrand: unique symbol;
export interface GLMTrustedChatImages {
  readonly [trustedImagesBrand]: true;
  readonly urls: readonly string[];
}

const trustedImagePermissions = new WeakMap<
  object,
  { scopeKey: string; urls: ReadonlySet<string> }
>();
const MAX_TRUSTED_IMAGE_COUNT = 6;
const MAX_TRUSTED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TRUSTED_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

/** Only server code with authenticated asset bytes may create this non-serializable permission. */
export const createTrustedChatImages = (
  images: readonly GLMServerImageInput[],
  scope: RuntimeScope,
): GLMTrustedChatImages => {
  const owner = cloneScope(scope);
  if (!Array.isArray(images) || images.length > MAX_TRUSTED_IMAGE_COUNT)
    throw invalid('Trusted image input is limited to six images', 'trustedImages');
  let totalBytes = 0;
  const urls = images.map((image) => {
    if (
      !image ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) ||
      typeof image.base64 !== 'string' ||
      !image.base64 ||
      image.base64.length > Math.ceil(MAX_TRUSTED_IMAGE_BYTES / 3) * 4 ||
      !/^[\d+/A-Za-z]+={0,2}$/u.test(image.base64)
    )
      throw invalid('Trusted images must be bounded PNG, JPEG or WebP data', 'trustedImages');
    const bytes = Buffer.from(image.base64, 'base64');
    totalBytes += bytes.length;
    if (
      bytes.length > MAX_TRUSTED_IMAGE_BYTES ||
      totalBytes > MAX_TRUSTED_IMAGE_TOTAL_BYTES ||
      bytes.toString('base64') !== image.base64
    )
      throw invalid('Trusted image base64 is invalid or exceeds the size limit', 'trustedImages');
    const matchesType =
      image.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.mimeType === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!matchesType)
      throw invalid('Trusted image data does not match its MIME type', 'trustedImages');
    return `data:${image.mimeType};base64,${image.base64}`;
  });
  const permission = Object.freeze({ urls: Object.freeze(urls) }) as GLMTrustedChatImages;
  trustedImagePermissions.set(permission, { scopeKey: scopeKey(owner), urls: new Set(urls) });
  return permission;
};

export interface GLMChatProviderManifest {
  readonly displayName: string;
  readonly model: string;
  readonly providerId: string;
  readonly supportsIdempotency: boolean;
  readonly supportsVision: boolean;
}

export interface GLMMultimodalChatPort {
  readonly chat: (request: GLMChatRequest, context: GLMChatContext) => Promise<GLMChatResult>;
  readonly manifest: GLMChatProviderManifest;
  readonly providerId: string;
}

export interface GLMChatProviderOptions {
  readonly allowRequestModelOverride?: boolean;
  readonly apiKey: string;
  readonly endpoint: string;
  readonly fetcher: GLMChatFetcher;
  readonly model?: string;
  readonly now?: () => number | string | Date;
  readonly providerId?: string;
}

export type GLMChatProviderErrorCode =
  | 'CHAT_CANCELLED'
  | 'CHAT_PAYLOAD_INVALID'
  | 'CHAT_PROVIDER_REJECTED'
  | 'CHAT_REQUEST_INVALID'
  | 'CHAT_SCOPE_INVALID'
  | 'CHAT_UNAVAILABLE';

export class GLMChatProviderError extends Error {
  constructor(
    public readonly code: GLMChatProviderErrorCode,
    message: string,
    public readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GLMChatProviderError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const providerError = (
  code: GLMChatProviderErrorCode,
  message: string,
  path?: string,
): GLMChatProviderError => new GLMChatProviderError(code, message, path);

const invalid = (message: string, path?: string): GLMChatProviderError =>
  providerError('CHAT_REQUEST_INVALID', message, path);

const payloadInvalid = (message: string, path?: string): GLMChatProviderError =>
  providerError('CHAT_PAYLOAD_INVALID', message, path);

const parseProviderJsonText = (raw: string): unknown => {
  const text = raw.replace(/^\uFEFF/u, '').trim();
  if (!text) throw new SyntaxError('empty response');
  try {
    return JSON.parse(text);
  } catch {
    const dataLines = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(dataLines[index]);
      } catch {
        // Some gateways accidentally return an SSE envelope for a non-stream request.
      }
    }
    throw new SyntaxError('invalid response');
  }
};

const unavailable = (message = 'Multimodal chat provider is unavailable'): GLMChatProviderError =>
  providerError('CHAT_UNAVAILABLE', message);

const cancelled = (): GLMChatProviderError =>
  providerError('CHAT_CANCELLED', 'Multimodal chat request was cancelled', 'signal');

export const assertSafeImageUrl = (url: unknown): string => {
  if (!nonEmptyString(url)) {
    throw invalid('Image URL must be a non-empty string', 'image_url.url');
  }
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('/') ||
    lower.startsWith('\\') ||
    lower.startsWith('webpack-internal:') ||
    lower.includes('base64')
  ) {
    throw invalid(
      'Image URL must not be a data URI, file URI, blob URI, local path, or base64 payload',
      'image_url.url',
    );
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('URL protocol must be http or https');
    }
  } catch {
    throw invalid('Image URL must be a valid HTTP/HTTPS URL', 'image_url.url');
  }
  return trimmed;
};

const cloneScope = (value: unknown): RuntimeScope => {
  if (!isRecord(value) || !nonEmptyString(value.userId) || !nonEmptyString(value.sessionId)) {
    throw providerError(
      'CHAT_SCOPE_INVALID',
      'scope.userId and scope.sessionId must be non-empty strings',
      'scope',
    );
  }
  return { sessionId: value.sessionId.trim(), userId: value.userId.trim() };
};

const scopeKey = (scope: RuntimeScope): string => JSON.stringify([scope.userId, scope.sessionId]);

const validateMessages = (
  messages: unknown,
  trustedImages?: ReadonlySet<string>,
): readonly GLMChatMessage[] => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid('messages must be a non-empty array', 'messages');
  }
  let trustedImageCount = 0;

  return Object.freeze(
    messages.map((m, index) => {
      if (!isRecord(m)) {
        throw invalid(`messages[${index}] must be an object`, `messages[${index}]`);
      }
      const role = m.role as 'assistant' | 'system' | 'user';
      if (role !== 'system' && role !== 'user' && role !== 'assistant') {
        throw invalid(
          `messages[${index}].role must be system, user, or assistant`,
          `messages[${index}].role`,
        );
      }

      if (typeof m.content === 'string') {
        return { content: m.content, role };
      }

      if (Array.isArray(m.content)) {
        const parts = m.content.map((part, partIndex) => {
          if (!isRecord(part)) {
            throw invalid(
              `messages[${index}].content[${partIndex}] must be an object`,
              `messages[${index}].content[${partIndex}]`,
            );
          }
          if (part.type === 'text') {
            if (typeof part.text !== 'string') {
              throw invalid(
                `messages[${index}].content[${partIndex}].text must be a string`,
                `messages[${index}].content[${partIndex}].text`,
              );
            }
            return { text: part.text, type: 'text' as const };
          }
          if (part.type === 'image_url') {
            if (!isRecord(part.image_url)) {
              throw invalid(
                `messages[${index}].content[${partIndex}].image_url must be an object`,
                `messages[${index}].content[${partIndex}].image_url`,
              );
            }
            const candidate = part.image_url.url;
            if (
              typeof candidate === 'string' &&
              trustedImages?.has(candidate) &&
              ++trustedImageCount > MAX_TRUSTED_IMAGE_COUNT
            )
              throw invalid('At most six trusted images can be sent per request', 'trustedImages');
            const safeUrl =
              typeof candidate === 'string' && trustedImages?.has(candidate)
                ? candidate
                : assertSafeImageUrl(candidate);
            return {
              image_url: {
                ...(part.image_url.detail ? { detail: part.image_url.detail as any } : {}),
                url: safeUrl,
              },
              type: 'image_url' as const,
            };
          }
          throw invalid(
            `messages[${index}].content[${partIndex}].type must be text or image_url`,
            `messages[${index}].content[${partIndex}].type`,
          );
        });

        return { content: Object.freeze(parts), role };
      }

      throw invalid(
        `messages[${index}].content must be a string or array of content parts`,
        `messages[${index}].content`,
      );
    }),
  );
};

export class GLMMultimodalChatAdapter implements GLMMultimodalChatPort {
  public readonly manifest: GLMChatProviderManifest;
  public readonly providerId: string;

  private readonly allowRequestModelOverride: boolean;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetcher: GLMChatFetcher;
  private readonly model: string;
  private readonly now: () => number;
  private readonly responseCache = new Map<string, GLMChatResult>();

  constructor(options: GLMChatProviderOptions) {
    if (!isRecord(options)) throw invalid('Options must be an object');
    if (!nonEmptyString(options.apiKey)) throw unavailable('Chat provider apiKey is required');
    if (!nonEmptyString(options.endpoint)) throw unavailable('Chat provider endpoint is required');
    if (typeof options.fetcher !== 'function')
      throw unavailable('Chat provider fetcher is required');

    this.allowRequestModelOverride = options.allowRequestModelOverride ?? true;
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint.trim();
    this.fetcher = options.fetcher;
    this.model = nonEmptyString(options.model)
      ? options.model.trim()
      : DEFAULT_MULTIMODAL_CHAT_MODEL;
    this.providerId = nonEmptyString(options.providerId)
      ? options.providerId.trim()
      : 'presentation-multimodal-chat';

    const nowFn = options.now;
    this.now = () => {
      if (typeof nowFn === 'function') {
        const val = nowFn();
        return typeof val === 'number'
          ? val
          : typeof val === 'string'
            ? Date.parse(val)
            : val.getTime();
      }
      return Date.now();
    };

    this.manifest = Object.freeze({
      displayName: '多模态聊天（OpenAI 兼容）',
      model: this.model,
      providerId: this.providerId,
      supportsIdempotency: true,
      supportsVision: true,
    });
  }

  async chat(request: GLMChatRequest, context: GLMChatContext): Promise<GLMChatResult> {
    if (!isRecord(request)) throw invalid('Request must be an object', 'request');
    if (!isRecord(context)) throw invalid('Context must be an object', 'context');

    const scope = cloneScope(context.scope);

    if (context.signal?.aborted) throw cancelled();
    const timeoutMs = context.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
      throw invalid('timeoutMs must be between 1 and 600000 milliseconds', 'timeoutMs');
    }
    const timeoutSignal = AbortSignal.timeout(Math.trunc(timeoutMs));
    const requestSignal =
      context.signal && timeoutSignal
        ? AbortSignal.any([context.signal, timeoutSignal])
        : (context.signal ?? timeoutSignal);

    const trustedImages = context.trustedImages
      ? trustedImagePermissions.get(context.trustedImages)
      : undefined;
    if (context.trustedImages && (!trustedImages || trustedImages.scopeKey !== scopeKey(scope)))
      throw invalid('Trusted image permissions cannot be supplied as JSON', 'trustedImages');
    const validatedMessages = validateMessages(request.messages, trustedImages?.urls);
    const resolvedModel =
      this.allowRequestModelOverride && nonEmptyString(request.model)
        ? request.model.trim()
        : this.model;

    const idempotencyKey = nonEmptyString(context.idempotencyKey)
      ? context.idempotencyKey.trim()
      : nonEmptyString(request.idempotencyKey)
        ? request.idempotencyKey.trim()
        : undefined;

    // A key belongs to an exact inference payload, not every planner call in a session.
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          ...request,
          model: resolvedModel,
          messages: validatedMessages,
        }),
      )
      .digest('hex');
    const cacheKey = idempotencyKey
      ? `${scopeKey(scope)}:${idempotencyKey}:${requestFingerprint}`
      : undefined;
    if (cacheKey && this.responseCache.has(cacheKey)) {
      return this.responseCache.get(cacheKey)!;
    }

    const payload: Record<string, unknown> = {
      messages: validatedMessages,
      model: resolvedModel,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(typeof request.max_tokens === 'number' ? { max_tokens: request.max_tokens } : {}),
      ...(request.response_format ? { response_format: request.response_format } : {}),
    };

    let response: GLMChatFetchResponse;
    try {
      response = await this.fetcher(this.endpoint, {
        body: JSON.stringify(payload),
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: requestSignal,
      });
    } catch (error: unknown) {
      if (context.signal?.aborted) {
        throw cancelled();
      }
      if (timeoutSignal?.aborted) throw unavailable('Multimodal chat request timed out');
      // Keep network diagnostics server-side; never log credentials, prompts or raw errors.
      const cause = error instanceof Error && isRecord(error.cause) ? error.cause : undefined;
      console.warn('[presentation.chat] transport interrupted', {
        code:
          typeof cause?.code === 'string' && /^[A-Z0-9_]+$/u.test(cause.code)
            ? cause.code
            : 'UNKNOWN',
        origin: URL.canParse(this.endpoint) ? new URL(this.endpoint).origin : 'invalid',
        provider: this.providerId,
        requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      });
      throw new GLMChatProviderError(
        'CHAT_UNAVAILABLE',
        '模型连接暂时中断，已完成的步骤已保留，请继续重试。',
        undefined,
        { cause: error },
      );
    }

    if (context.signal?.aborted) throw cancelled();

    if (!response.ok || response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) {
        throw providerError(
          'CHAT_PROVIDER_REJECTED',
          'Multimodal chat provider rejected authentication or authorization',
        );
      }
      if (response.status === 429 || response.status >= 500) {
        throw unavailable(`Multimodal chat provider returned HTTP ${response.status}`);
      }
      // Gateways may echo Authorization headers or prompts in error bodies.
      // Only the status is safe to propagate through the public runtime API.
      throw providerError(
        'CHAT_REQUEST_INVALID',
        `Multimodal chat provider returned HTTP ${response.status}`,
      );
    }

    let parsedBody: unknown;
    try {
      if (typeof response.text === 'function')
        parsedBody = parseProviderJsonText(await response.text());
      else if (typeof response.json === 'function') parsedBody = await response.json();
    } catch (error) {
      if (context.signal?.aborted) throw cancelled();
      if (timeoutSignal.aborted) throw unavailable('模型响应超时，已完成的步骤已保留。');
      throw new GLMChatProviderError(
        'CHAT_PAYLOAD_INVALID',
        '模型回复传输不完整，请从当前进度继续。',
        undefined,
        { cause: error },
      );
    }

    if (!isRecord(parsedBody)) {
      throw payloadInvalid('Multimodal chat response must be an object');
    }

    if (!Array.isArray(parsedBody.choices) || parsedBody.choices.length === 0) {
      throw payloadInvalid('Multimodal chat response choices must be a non-empty array');
    }

    const choices: GLMChatChoice[] = parsedBody.choices.map((c, idx) => {
      if (!isRecord(c) || !isRecord(c.message)) {
        throw payloadInvalid(`Multimodal chat response choices[${idx}] has invalid message`);
      }
      const rawContent = c.message.content;
      const reasoning =
        typeof c.message.reasoning_content === 'string' ? c.message.reasoning_content : undefined;
      const content =
        typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : undefined;
      if (content === undefined) {
        throw payloadInvalid(`Multimodal chat response choices[${idx}] has invalid message`);
      }
      return {
        finish_reason: typeof c.finish_reason === 'string' ? c.finish_reason : undefined,
        index: typeof c.index === 'number' ? c.index : idx,
        message: {
          content,
          role: 'assistant' as const,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
      };
    });

    const result: GLMChatResult = Object.freeze({
      choices: Object.freeze(choices),
      created:
        typeof parsedBody.created === 'number' ? parsedBody.created : Math.floor(this.now() / 1000),
      id: typeof parsedBody.id === 'string' ? parsedBody.id : `chatcmpl-${this.now()}`,
      model: typeof parsedBody.model === 'string' ? parsedBody.model : resolvedModel,
      usage: isRecord(parsedBody.usage)
        ? {
            completion_tokens:
              typeof parsedBody.usage.completion_tokens === 'number'
                ? parsedBody.usage.completion_tokens
                : undefined,
            prompt_tokens:
              typeof parsedBody.usage.prompt_tokens === 'number'
                ? parsedBody.usage.prompt_tokens
                : undefined,
            total_tokens:
              typeof parsedBody.usage.total_tokens === 'number'
                ? parsedBody.usage.total_tokens
                : undefined,
          }
        : undefined,
    });

    if (cacheKey && choices.some((choice) => choice.message.content.trim())) {
      this.responseCache.set(cacheKey, result);
    }

    return result;
  }
}

export const createGLMMultimodalChatPort = (
  options: GLMChatProviderOptions,
): GLMMultimodalChatPort => new GLMMultimodalChatAdapter(options);

/**
 * Provider-neutral aliases used by the production presentation pipeline.
 * The GLM-suffixed exports above remain only as a source-compatibility seam
 * for older integrations; no GLM provider is registered or selected by
 * default anymore.
 */
export type MultimodalChatFetchResponse = GLMChatFetchResponse;
export type MultimodalChatFetcher = GLMChatFetcher;
export type MultimodalImageContentPart = GLMImageContentPart;
export type MultimodalTextContentPart = GLMTextContentPart;
export type MultimodalChatContentPart = GLMChatContentPart;
export type MultimodalChatMessage = GLMChatMessage;
export type MultimodalChatRequest = GLMChatRequest;
export type MultimodalChatChoice = GLMChatChoice;
export type MultimodalChatUsage = GLMChatUsage;
export type MultimodalChatResult = GLMChatResult;
export type MultimodalChatContext = GLMChatContext;
export type MultimodalChatProviderManifest = GLMChatProviderManifest;
export type MultimodalChatPort = GLMMultimodalChatPort;
export type MultimodalChatProviderOptions = GLMChatProviderOptions;
export type MultimodalChatProviderErrorCode = GLMChatProviderErrorCode;
export const MultimodalChatProviderError = GLMChatProviderError;
export const createMultimodalChatPort = createGLMMultimodalChatPort;
