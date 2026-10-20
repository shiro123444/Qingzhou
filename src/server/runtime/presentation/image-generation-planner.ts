/**
 * C-84 server-only image-generation planning seam.
 *
 * This module coordinates an injected image port, asset store and event
 * publisher. It deliberately has no environment, HTTP, database, filesystem,
 * provider SDK or process boundary.
 */

import type {
  AssetRef,
  ImageGenerationPort,
  ImageGenerationRequest,
  ImageGenerationResult,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  IMAGE_GENERATION_EVENT_TYPES,
  type ImageGenerationEventPublisherPort,
} from './asset-events';
import type { PresentationAssetSnapshot, PresentationAssetStore } from './asset-store';

export interface ImageGenerationSlot {
  readonly background?: ImageGenerationRequest['background'];
  readonly count?: number;
  readonly idempotencyKey?: string;
  readonly prompt: string;
  readonly quality?: string;
  readonly referenceAssetRefs?: readonly string[];
  readonly size?: string;
  readonly slideId: string;
  readonly slotId: string;
}

export interface ImageGenerationPlanInput {
  readonly jobId?: string;
  readonly scope: RuntimeScope;
  readonly signal?: AbortSignal;
  readonly slots: readonly ImageGenerationSlot[];
}

export type ImageGenerationSlotState = 'cancelled' | 'failed' | 'ready';

export interface ImageGenerationSlotError {
  readonly code: ImageGenerationPlannerErrorCode;
  readonly message: string;
}

export interface ImageGenerationSlotOutput {
  readonly assetRefs: readonly AssetRef[];
  readonly error?: ImageGenerationSlotError;
  readonly slideId: string;
  readonly slotId: string;
  readonly state: ImageGenerationSlotState;
}

export interface ImageGenerationPlanOutput {
  readonly jobId: string;
  readonly scope: RuntimeScope;
  readonly slots: readonly ImageGenerationSlotOutput[];
}

export interface ImageGenerationPlannerOptions {
  readonly assetStore: PresentationAssetStore;
  readonly concurrency?: number;
  readonly eventPublisher: ImageGenerationEventPublisherPort;
  readonly imagePort: ImageGenerationPort;
  readonly maxDurationMs?: number;
  readonly maxImages?: number;
  readonly maxRetries?: number;
  readonly now?: () => number | string;
}

export type ImageGenerationPlannerErrorCode =
  | 'ASSET_DUPLICATE'
  | 'ASSET_IDEMPOTENCY_CONFLICT'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_SCOPE_MISMATCH'
  | 'IMAGE_BUDGET_EXCEEDED'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_PAYLOAD_INVALID'
  | 'IMAGE_PLAN_INVALID'
  | 'IMAGE_UNAVAILABLE';

const ERROR_MESSAGES: Record<ImageGenerationPlannerErrorCode, string> = {
  ASSET_DUPLICATE: 'An asset already exists for this slot.',
  ASSET_IDEMPOTENCY_CONFLICT: 'The asset idempotency key conflicts with an existing asset.',
  ASSET_NOT_FOUND: 'The generated asset could not be found.',
  ASSET_SCOPE_MISMATCH: 'The generated asset belongs to another scope.',
  IMAGE_BUDGET_EXCEEDED: 'The image-generation budget was exceeded.',
  IMAGE_CANCELLED: 'Image generation was cancelled.',
  IMAGE_PAYLOAD_INVALID: 'The image provider returned an invalid payload.',
  IMAGE_PLAN_INVALID: 'The image-generation plan is invalid.',
  IMAGE_UNAVAILABLE: 'The image provider is unavailable.',
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_IMAGES = 64;
const DEFAULT_MAX_RETRIES = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const cloneValue = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const cloneScope = (scope: RuntimeScope): RuntimeScope => ({
  sessionId: scope.sessionId,
  userId: scope.userId,
});

const cloneAssetRef = (asset: AssetRef): AssetRef => cloneValue(asset);

const scopeKey = (scope: RuntimeScope): string =>
  JSON.stringify([scope.userId.trim(), scope.sessionId.trim()]);

const slotKey = (slot: Pick<ImageGenerationSlot, 'slideId' | 'slotId'>): string =>
  `${slot.slideId}\u0000${slot.slotId}`;

const fingerprint = (scope: RuntimeScope, slot: ImageGenerationSlot): string =>
  JSON.stringify([
    scopeKey(scope),
    slot.slideId,
    slot.slotId,
    slot.prompt,
    slot.size ?? null,
    slot.quality ?? null,
    slot.count ?? 1,
    slot.idempotencyKey ?? null,
    slot.referenceAssetRefs ?? [],
    slot.background ?? null,
  ]);

const compareSlots = (
  left: Pick<ImageGenerationSlot, 'slideId' | 'slotId'>,
  right: Pick<ImageGenerationSlot, 'slideId' | 'slotId'>,
): number => {
  if (left.slideId < right.slideId) return -1;
  if (left.slideId > right.slideId) return 1;
  if (left.slotId < right.slotId) return -1;
  if (left.slotId > right.slotId) return 1;
  return 0;
};

const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.codePointAt(index) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
};

const stableJobId = (scope: RuntimeScope, slots: readonly ImageGenerationSlot[]): string =>
  `image-generation:${hash(
    JSON.stringify([scopeKey(scope), ...slots.map((slot) => fingerprint(scope, slot))]),
  )}`;

const readClock = (now: () => number | string): number => {
  const value = now();
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'now must return a valid time');
  }
  return timestamp;
};

const normalizeScope = (scope: unknown): RuntimeScope => {
  if (!isRecord(scope) || !nonEmpty(scope.userId) || !nonEmpty(scope.sessionId)) {
    throw new ImageGenerationPlannerError(
      'ASSET_SCOPE_MISMATCH',
      'userId and sessionId must be non-empty strings',
    );
  }
  return { sessionId: scope.sessionId.trim(), userId: scope.userId.trim() };
};

const normalizePositiveLimit = (
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || (allowZero ? normalized < 0 : normalized < 1)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', `${name} must be a valid limit`);
  }
  return normalized;
};

const normalizeSlot = (value: unknown): ImageGenerationSlot => {
  if (!isRecord(value)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'slot must be an object');
  }
  if (!nonEmpty(value.slideId)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'slideId must be non-empty');
  }
  if (!nonEmpty(value.slotId)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'slotId must be non-empty');
  }
  if (!nonEmpty(value.prompt)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'prompt must be non-empty');
  }
  const optionalString = (field: string, fieldValue: unknown): string | undefined => {
    if (fieldValue === undefined) return undefined;
    if (!nonEmpty(fieldValue)) {
      throw new ImageGenerationPlannerError(
        'IMAGE_PLAN_INVALID',
        `${field} must be non-empty when provided`,
      );
    }
    return fieldValue.trim();
  };
  const idempotencyKey = optionalString('idempotencyKey', value.idempotencyKey);
  const quality = optionalString('quality', value.quality);
  const size = optionalString('size', value.size);
  const countValue = value.count;
  if (
    value.referenceAssetRefs !== undefined &&
    (!Array.isArray(value.referenceAssetRefs) ||
      value.referenceAssetRefs.length > 4 ||
      value.referenceAssetRefs.some((ref) => !nonEmpty(ref) || ref.length > 256))
  )
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'Invalid visual references');
  if (
    value.background !== undefined &&
    !['transparent', 'opaque', 'auto'].includes(String(value.background))
  )
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'Invalid background mode');
  const count = countValue === undefined ? 1 : countValue;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'count must be a positive integer');
  }
  return {
    count,
    ...(value.referenceAssetRefs === undefined
      ? {}
      : { referenceAssetRefs: [...(value.referenceAssetRefs as string[])] }),
    ...(value.background === undefined
      ? {}
      : { background: value.background as ImageGenerationRequest['background'] }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    prompt: value.prompt,
    ...(quality === undefined ? {} : { quality }),
    ...(size === undefined ? {} : { size }),
    slideId: value.slideId.trim(),
    slotId: value.slotId.trim(),
  };
};

const normalizeSlots = (value: unknown): ImageGenerationSlot[] => {
  if (!Array.isArray(value)) {
    throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'slots must be an array', 'slots');
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    const slot = normalizeSlot(candidate);
    const key = slotKey(slot);
    if (seen.has(key)) {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'slotId must be unique');
    }
    seen.add(key);
    return slot;
  });
};

const plannerCode = (value: unknown): ImageGenerationPlannerErrorCode | undefined => {
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  const code = value.code as ImageGenerationPlannerErrorCode;
  return code in ERROR_MESSAGES ? code : undefined;
};

const isAbortError = (error: unknown, signal: AbortSignal): boolean =>
  signal.aborted ||
  (error instanceof Error && error.name === 'AbortError') ||
  (isRecord(error) && error.code === 'ABORT_ERR');

const eventKey = (slot: ImageGenerationSlot, phase: string, suffix = '') =>
  `slot:${slot.slideId}:${slot.slotId}:${phase}${suffix ? `:${suffix}` : ''}`;

const slotOutput = (
  slot: ImageGenerationSlot,
  state: ImageGenerationSlotState,
  assetRefs: readonly AssetRef[] = [],
  error?: ImageGenerationSlotError,
): ImageGenerationSlotOutput => ({
  assetRefs: assetRefs.map(cloneAssetRef),
  ...(error ? { error: { ...error } } : {}),
  slideId: slot.slideId,
  slotId: slot.slotId,
  state,
});

export class ImageGenerationPlannerError extends Error {
  constructor(
    public readonly code: ImageGenerationPlannerErrorCode,
    message = ERROR_MESSAGES[code],
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ImageGenerationPlannerError';
  }
}

interface CachedSlot {
  readonly output: ImageGenerationSlotOutput;
}

interface ValidatedResult {
  readonly index: number;
  readonly result: ImageGenerationResult;
}

/** Coordinates bounded, scope-aware image generation without provider side effects. */
export class ImageGenerationPlanner {
  private readonly assetStore: PresentationAssetStore;
  private readonly concurrency: number;
  private readonly eventPublisher: ImageGenerationEventPublisherPort;
  private readonly imagePort: ImageGenerationPort;
  private readonly maxDurationMs?: number;
  private readonly maxImages: number;
  private readonly maxRetries: number;
  private readonly now: () => number | string;
  private readonly cache = new Map<string, CachedSlot>();

  constructor(options: ImageGenerationPlannerOptions) {
    if (!isRecord(options) || !isRecord(options.imagePort)) {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'imagePort is required');
    }
    if (typeof options.imagePort.generate !== 'function') {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'imagePort.generate is required');
    }
    if (!isRecord(options.assetStore) || typeof options.assetStore.put !== 'function') {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'assetStore is required');
    }
    if (!isRecord(options.eventPublisher) || typeof options.eventPublisher.publish !== 'function') {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'eventPublisher is required');
    }
    this.assetStore = options.assetStore;
    this.concurrency = normalizePositiveLimit(
      options.concurrency,
      DEFAULT_CONCURRENCY,
      'concurrency',
    );
    this.maxImages = normalizePositiveLimit(options.maxImages, DEFAULT_MAX_IMAGES, 'maxImages');
    this.maxRetries = normalizePositiveLimit(
      options.maxRetries,
      DEFAULT_MAX_RETRIES,
      'maxRetries',
      true,
    );
    if (
      options.maxDurationMs !== undefined &&
      (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 0)
    ) {
      throw new ImageGenerationPlannerError(
        'IMAGE_PLAN_INVALID',
        'maxDurationMs must be a non-negative integer',
      );
    }
    this.maxDurationMs = options.maxDurationMs;
    this.now = options.now ?? (() => Date.now());
    this.eventPublisher = options.eventPublisher;
    this.imagePort = options.imagePort;
  }

  async plan(input: ImageGenerationPlanInput): Promise<ImageGenerationPlanOutput> {
    const { jobId, signal, slots, scope } = this.validateInput(input);
    const startedAt = readClock(this.now);
    const totalImages = slots.reduce((sum, slot) => sum + (slot.count ?? 1), 0);
    if (totalImages > this.maxImages) {
      throw new ImageGenerationPlannerError('IMAGE_BUDGET_EXCEEDED', 'image count budget exceeded');
    }
    this.eventPublisher.assertScope(scope);

    const outputs = new Map<string, ImageGenerationSlotOutput>();
    const pending: ImageGenerationSlot[] = [];
    for (const slot of slots) {
      const cached = this.cache.get(fingerprint(scope, slot));
      if (cached) outputs.set(slotKey(slot), slotOutput(slot, 'ready', cached.output.assetRefs));
      else pending.push(slot);
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        const slot = pending[cursor++];
        outputs.set(
          slotKey(slot),
          await this.processSlot({
            jobId,
            scope,
            signal,
            slot,
            startedAt,
          }),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, Math.max(pending.length, 1)) }, worker),
    );

    return {
      jobId,
      scope: cloneScope(scope),
      slots: slots
        .map((slot) => outputs.get(slotKey(slot))!)
        .sort((left, right) => {
          const leftSlot = { slideId: left.slideId, slotId: left.slotId };
          const rightSlot = { slideId: right.slideId, slotId: right.slotId };
          return compareSlots(leftSlot, rightSlot);
        }),
    };
  }

  /** Reuses successful slot cache entries and retries only failed/missing slots. */
  async retry(input: ImageGenerationPlanInput): Promise<ImageGenerationPlanOutput> {
    return this.plan(input);
  }

  /** Alias for callers that model the planner as a generation service. */
  async generate(input: ImageGenerationPlanInput): Promise<ImageGenerationPlanOutput> {
    return this.plan(input);
  }

  private validateInput(input: ImageGenerationPlanInput): {
    jobId: string;
    signal?: AbortSignal;
    slots: ImageGenerationSlot[];
    scope: RuntimeScope;
  } {
    if (!isRecord(input)) {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'input must be an object');
    }
    const scope = normalizeScope(input.scope);
    const slots = normalizeSlots(input.slots).sort(compareSlots);
    const suppliedJobId = input.jobId;
    if (suppliedJobId !== undefined && !nonEmpty(suppliedJobId)) {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'jobId must be non-empty');
    }
    if (input.signal !== undefined && typeof input.signal.aborted !== 'boolean') {
      throw new ImageGenerationPlannerError('IMAGE_PLAN_INVALID', 'signal is invalid');
    }
    return {
      jobId: suppliedJobId?.trim() ?? stableJobId(scope, slots),
      signal: input.signal,
      slots,
      scope,
    };
  }

  private async processSlot(input: {
    readonly jobId: string;
    readonly scope: RuntimeScope;
    readonly signal?: AbortSignal;
    readonly slot: ImageGenerationSlot;
    readonly startedAt: number;
  }): Promise<ImageGenerationSlotOutput> {
    const { jobId, scope, signal, slot, startedAt } = input;
    this.publish(jobId, scope, slot, IMAGE_GENERATION_EVENT_TYPES.accepted, 'accepted', {
      count: slot.count ?? 1,
      slideId: slot.slideId,
      slotId: slot.slotId,
    });

    if (signal?.aborted) return this.cancelled(jobId, scope, slot, 'IMAGE_CANCELLED');
    if (this.exceeded(startedAt)) {
      return this.failed(jobId, scope, slot, 'IMAGE_BUDGET_EXCEEDED');
    }

    const request: ImageGenerationRequest = {
      count: slot.count,
      ...(slot.referenceAssetRefs?.length ? { referenceAssetRefs: slot.referenceAssetRefs } : {}),
      ...(slot.background ? { background: slot.background } : {}),
      ...(slot.idempotencyKey === undefined ? {} : { idempotencyKey: slot.idempotencyKey }),
      prompt: slot.prompt,
      ...(slot.quality === undefined ? {} : { quality: slot.quality }),
      ...(slot.size === undefined ? {} : { size: slot.size }),
    };
    let lastCode: ImageGenerationPlannerErrorCode = 'IMAGE_UNAVAILABLE';
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      if (signal?.aborted) return this.cancelled(jobId, scope, slot, 'IMAGE_CANCELLED');
      if (this.exceeded(startedAt)) return this.failed(jobId, scope, slot, 'IMAGE_BUDGET_EXCEEDED');
      this.publish(jobId, scope, slot, IMAGE_GENERATION_EVENT_TYPES.started, `started:${attempt}`, {
        attempt,
        slideId: slot.slideId,
        slotId: slot.slotId,
      });

      const controller = new AbortController();
      const removeAbortListener = this.linkSignal(signal, controller);
      const timeout = this.scheduleAbort(controller, startedAt);
      try {
        const remaining = this.remaining(startedAt);
        const results = await this.imagePort.generate(request, {
          scope: cloneScope(scope),
          ...(remaining === undefined ? {} : { timeoutMs: remaining }),
          signal: controller.signal,
        });
        if (controller.signal.aborted || signal?.aborted) {
          return this.cancelled(jobId, scope, slot, 'IMAGE_CANCELLED');
        }
        if (this.exceeded(startedAt)) {
          return this.failed(jobId, scope, slot, 'IMAGE_BUDGET_EXCEEDED');
        }
        const validResults = this.validateResults(results, slot.count ?? 1);
        this.publish(
          jobId,
          scope,
          slot,
          IMAGE_GENERATION_EVENT_TYPES.progress,
          `progress:${attempt}:complete`,
          {
            completed: validResults.length,
            slideId: slot.slideId,
            slotId: slot.slotId,
            total: slot.count ?? 1,
          },
        );
        const refs: AssetRef[] = [];
        for (const { index, result } of validResults) {
          const stored = await this.persist(scope, slot, index, result);
          refs.push(stored.asset);
          this.publish(
            jobId,
            scope,
            slot,
            IMAGE_GENERATION_EVENT_TYPES.assetReady,
            `asset-ready:${attempt}:${index}`,
            {
              asset: stored.asset,
              metadata: stored.metadata,
              index,
              slideId: slot.slideId,
              slotId: slot.slotId,
            },
            stored.metadata.assetId,
          );
        }
        const output = slotOutput(slot, 'ready', refs);
        this.cache.set(fingerprint(scope, slot), { output });
        return output;
      } catch (error) {
        if (isAbortError(error, controller.signal) || signal?.aborted) {
          return this.cancelled(jobId, scope, slot, 'IMAGE_CANCELLED');
        }
        lastCode = plannerCode(error) ?? 'IMAGE_UNAVAILABLE';
        if (attempt <= this.maxRetries) continue;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        removeAbortListener();
      }
    }
    return this.failed(jobId, scope, slot, lastCode);
  }

  private publish(
    jobId: string,
    scope: RuntimeScope,
    slot: ImageGenerationSlot,
    type: (typeof IMAGE_GENERATION_EVENT_TYPES)[keyof typeof IMAGE_GENERATION_EVENT_TYPES],
    phase: string,
    data: Record<string, unknown>,
    assetId?: string,
  ): void {
    this.eventPublisher.publish({
      ...(assetId === undefined ? {} : { assetId }),
      data,
      idempotencyKey: eventKey(slot, phase),
      jobId,
      scope: cloneScope(scope),
      type,
    });
  }

  private failed(
    jobId: string,
    scope: RuntimeScope,
    slot: ImageGenerationSlot,
    code: ImageGenerationPlannerErrorCode,
  ): ImageGenerationSlotOutput {
    this.publish(jobId, scope, slot, IMAGE_GENERATION_EVENT_TYPES.failed, 'failed', {
      code,
      slideId: slot.slideId,
      slotId: slot.slotId,
    });
    return slotOutput(slot, 'failed', [], {
      code,
      message: ERROR_MESSAGES[code],
    });
  }

  private cancelled(
    jobId: string,
    scope: RuntimeScope,
    slot: ImageGenerationSlot,
    code: 'IMAGE_BUDGET_EXCEEDED' | 'IMAGE_CANCELLED',
  ): ImageGenerationSlotOutput {
    this.publish(jobId, scope, slot, IMAGE_GENERATION_EVENT_TYPES.cancelled, 'cancelled', {
      code,
      slideId: slot.slideId,
      slotId: slot.slotId,
    });
    return slotOutput(slot, 'cancelled', [], {
      code,
      message: ERROR_MESSAGES[code],
    });
  }

  private exceeded(startedAt: number): boolean {
    return (
      this.maxDurationMs !== undefined && readClock(this.now) - startedAt >= this.maxDurationMs
    );
  }

  private remaining(startedAt: number): number | undefined {
    if (this.maxDurationMs === undefined) return undefined;
    return Math.max(0, this.maxDurationMs - (readClock(this.now) - startedAt));
  }

  private linkSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => {};
    const abort = (): void => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  private scheduleAbort(
    controller: AbortController,
    startedAt: number,
  ): ReturnType<typeof setTimeout> | undefined {
    const remaining = this.remaining(startedAt);
    if (remaining === undefined) return undefined;
    return setTimeout(() => controller.abort(), remaining);
  }

  private validateResults(value: unknown, requestedCount: number): ValidatedResult[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > requestedCount) {
      throw new ImageGenerationPlannerError(
        'IMAGE_PAYLOAD_INVALID',
        'provider result count is invalid',
      );
    }
    const indexes = new Set<number>();
    return value.map((candidate) => {
      if (!isRecord(candidate)) {
        throw new ImageGenerationPlannerError(
          'IMAGE_PAYLOAD_INVALID',
          'provider result is invalid',
        );
      }
      const index = candidate.index;
      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        indexes.has(index)
      ) {
        throw new ImageGenerationPlannerError(
          'IMAGE_PAYLOAD_INVALID',
          'provider result index is invalid',
        );
      }
      indexes.add(index);
      if (!isRecord(candidate.asset) || !nonEmpty(candidate.asset.ref)) {
        throw new ImageGenerationPlannerError(
          'IMAGE_PAYLOAD_INVALID',
          'provider asset ref is invalid',
        );
      }
      if (!isRecord(candidate.metadata) || !nonEmpty(candidate.metadata.createdAt)) {
        throw new ImageGenerationPlannerError(
          'IMAGE_PAYLOAD_INVALID',
          'provider asset metadata is invalid',
        );
      }
      if (!nonEmpty(candidate.metadata.mimeType)) {
        throw new ImageGenerationPlannerError(
          'IMAGE_PAYLOAD_INVALID',
          'provider mimeType is invalid',
        );
      }
      return { index, result: candidate as unknown as ImageGenerationResult };
    });
  }

  private async persist(
    scope: RuntimeScope,
    slot: ImageGenerationSlot,
    index: number,
    result: ImageGenerationResult,
  ): Promise<PresentationAssetSnapshot> {
    const idempotencyKey = `${fingerprint(scope, slot)}:${index}`;
    try {
      return await this.assetStore.put(scope, {
        asset: cloneAssetRef(result.asset),
        idempotencyKey,
        metadata: cloneValue(result.metadata),
      });
    } catch (error) {
      if (plannerCode(error) === 'ASSET_DUPLICATE') {
        return this.assetStore.getSnapshot(scope, result.asset.ref);
      }
      throw error;
    }
  }
}

export const createImageGenerationPlanner = (
  options: ImageGenerationPlannerOptions,
): ImageGenerationPlanner => new ImageGenerationPlanner(options);
