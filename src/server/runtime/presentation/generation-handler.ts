import type {
  ArtifactSnapshot,
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ExecutionLimiter } from '../execution-limiter';
import type { PresentationGenerationCapability } from './generation-capability';
import type { PresentationPipelineContext } from './pipeline';
import type { PresentationJobEventPublisherPort } from './publisher';

export interface PresentationGenerationHttpResponse {
  body: unknown;
  headers: { 'content-type': 'application/json' };
  status: number;
}

export type PresentationGenerationEventPublisherFactory = (
  scope: RuntimeScope,
  jobId: string,
  request: Request,
) =>
  | PresentationJobEventPublisherPort
  | undefined
  | Promise<PresentationJobEventPublisherPort | undefined>;

export interface PresentationGenerationRequestOptions {
  readonly executionLimiter?: ExecutionLimiter;
  readonly generationEventPublisherFactory?: PresentationGenerationEventPublisherFactory;
}

const headers = { 'content-type': 'application/json' } as const;
const bad = (message: string): PresentationGenerationHttpResponse => ({
  status: 400,
  headers,
  body: { error: { code: 'PRESENTATION_INVALID', message } },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const clone = <T>(value: T): T => {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (Array.isArray(value)) return value.map((x) => clone(x)) as T;
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) result[key] = clone(nested);
    return result as T;
  }
  return value;
};

const wireForbiddenKeys = new Set(['bytes', 'workspace', 'workspacePath', 'path']);

/** Recursively projects internal results to JSON-safe, non-binary wire data. */
const wireSafe = (value: unknown, key?: string): unknown => {
  if (key && wireForbiddenKeys.has(key)) return undefined;
  if (value instanceof Uint8Array) return undefined;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const safe = wireSafe(item);
      if (safe !== undefined) result.push(safe);
    }
    return result;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      const safe = wireSafe(nested, nestedKey);
      if (safe !== undefined) result[nestedKey] = safe;
    }
    return result;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return undefined;
};

const statusByCode: Readonly<Record<string, number>> = {
  CAPACITY_BUSY: 503,
  NOT_FOUND: 404,
  OPERATION_CANCELLED: 499,
  PRESENTATION_INVALID: 400,
  PRESENTATION_EVENT_SCOPE_DENIED: 403,
  PRESENTATION_QUALITY_FAILED: 502,
  PRESENTATION_WORKER_CANCELLED: 499,
  PPTX_INVALID: 502,
  PROVIDER_UNAVAILABLE: 503,
};

const status = (code: string): number =>
  statusByCode[code] ?? (code.endsWith('_NOT_FOUND') ? 404 : 500);

const errorProperty = (error: unknown, property: string): unknown =>
  isRecord(error) ? error[property] : undefined;

const errorCode = (error: unknown): string =>
  nonEmptyString(errorProperty(error, 'code'))
    ? (errorProperty(error, 'code') as string)
    : 'PRESENTATION_INTERNAL_ERROR';

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return nonEmptyString(errorProperty(error, 'message'))
    ? (errorProperty(error, 'message') as string)
    : 'Presentation generation failed';
};

const errorResponse = (error: unknown): PresentationGenerationHttpResponse => {
  const code = errorCode(error);
  const details = wireSafe(errorProperty(error, 'details'));
  return {
    status: status(code),
    headers,
    body: {
      error: {
        code,
        message: errorMessage(error),
        ...(details !== undefined ? { details } : {}),
      },
    },
  };
};

const validScope = (value: unknown): value is RuntimeScope =>
  isRecord(value) && nonEmptyString(value.userId) && nonEmptyString(value.sessionId);

export const handlePresentationGenerationRequest = async (
  request: Request,
  scope: RuntimeScope,
  capability: PresentationGenerationCapability,
  contextFactory: (jobId: string) => PresentationPipelineContext,
  options: PresentationGenerationRequestOptions = {},
): Promise<PresentationGenerationHttpResponse> => {
  let releaseCapacity: (() => void) | undefined;
  let eventPublisher: PresentationJobEventPublisherPort | undefined;
  try {
    if (request.method !== 'POST') return bad('Only POST is supported');
    if (!validScope(scope)) return bad('userId and sessionId are required');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return bad('Request body must be valid JSON');
    }
    if (!isPlainObject(body)) return bad('Request body must be a JSON object');

    // A presentation can be created from a prompt alone.  Older clients sent
    // notebookId/title/sourceVersionIds explicitly, while the current studio
    // may omit the notebook and reference list until the user attaches them.
    // Normalize those omitted fields at the HTTP boundary, but continue to
    // reject explicitly supplied malformed values.
    const notebookId =
      body.notebookId === undefined || body.notebookId === ''
        ? 'studio'
        : nonEmptyString(body.notebookId)
          ? body.notebookId.trim()
          : undefined;
    const prompt = nonEmptyString(body.prompt)
      ? body.prompt.trim()
      : nonEmptyString(body.options && isRecord(body.options) ? body.options.prompt : undefined)
        ? String((body.options as Record<string, unknown>).prompt).trim()
        : undefined;
    const title =
      body.title === undefined || body.title === ''
        ? prompt?.split(/\r?\n/, 1)[0]?.trim().slice(0, 120) || '智能演示文稿'
        : nonEmptyString(body.title)
          ? body.title.trim()
          : undefined;
    const sourceVersionIds =
      body.sourceVersionIds === undefined
        ? []
        : Array.isArray(body.sourceVersionIds) &&
            body.sourceVersionIds.every((id) => nonEmptyString(id))
          ? body.sourceVersionIds.map((id) => id.trim())
          : undefined;
    if (!notebookId || !title || !sourceVersionIds) {
      return bad('notebookId, title and sourceVersionIds are required');
    }

    const input = {
      ...body,
      notebookId,
      title,
      sourceVersionIds,
      ...(prompt ? { prompt } : {}),
    } as unknown as PresentationJobInput;
    releaseCapacity = await options.executionLimiter?.acquire(request.signal);
    if (request.signal.aborted)
      throw Object.assign(new Error('Generation request cancelled'), {
        code: 'OPERATION_CANCELLED',
      });
    const jobId = `generation-${Date.now()}`;
    const produced = contextFactory(jobId);
    eventPublisher = options.generationEventPublisherFactory
      ? await options.generationEventPublisherFactory(scope, jobId, request)
      : undefined;
    if (eventPublisher) eventPublisher.assertScope(scope);
    const context = {
      ...produced,
      plannerContext: { ...produced.plannerContext, abortSignal: request.signal, scope },
      workerContext: {
        ...produced.workerContext,
        abortSignal: request.signal,
        ...(eventPublisher ? { eventPublisher, eventScope: scope } : {}),
      },
    };
    const result = await capability.execute(scope, clone(input), context);
    const snapshots = result.artifacts.map((artifact: ArtifactSnapshot) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      status: artifact.status,
      ...(artifact.name !== undefined ? { name: artifact.name } : {}),
      ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
      ...(artifact.uri !== undefined ? { uri: artifact.uri } : {}),
    }));
    return {
      status: 200,
      headers,
      body: {
        plan: wireSafe(result.plan),
        jobId: wireSafe(result.worker.jobId),
        quality: wireSafe(result.worker.qualityReport),
        artifacts: wireSafe(snapshots),
      },
    };
  } catch (error) {
    return errorResponse(error);
  } finally {
    try {
      eventPublisher?.dispose?.();
    } finally {
      releaseCapacity?.();
    }
  }
};
