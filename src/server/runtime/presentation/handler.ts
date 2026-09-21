import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJobInput,
  PresentationPort,
} from '../../../../packages/cordis-kernel/src/presentation';
import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src';
import {
  PRESENTATION_PPTX_MAX_UPLOAD_BYTES,
  PRESENTATION_PPTX_MAX_UPLOAD_MIB,
} from '../../../../packages/runtime-contracts/src';
import type {
  PresentationFactoryScope,
  PresentationPortBinding,
  PresentationPortFactory,
} from './factory';
import { getPresentationPortFactory } from './factory';
import type { PresentationGenerationPort } from './generation-port';
import { readPresentationUploadForm } from './upload-form';

export type {
  ArtifactSnapshot,
  ExportResult,
  PresentationExportFormat,
  PresentationJob,
  PresentationJobInput,
  PresentationPort,
} from '../../../../packages/cordis-kernel/src/presentation';
export type {
  PresentationFactoryScope,
  PresentationPortBinding,
  PresentationPortFactory,
} from './factory';

export type PresentationRouteOperation =
  | 'message'
  | 'templates'
  | 'deleteTemplate'
  | 'learnTemplate'
  | 'importTemplate'
  | 'applyTemplate'
  | 'tools'
  | 'tool'
  | 'create'
  | 'get'
  | 'deleteJob'
  | 'cancel'
  | 'retry'
  | 'getArtifact'
  | 'exportArtifact'
  | 'notFound';

export interface PresentationRouteMatch {
  readonly id?: string;
  readonly operation: PresentationRouteOperation;
  readonly raw?: boolean;
}

export interface PresentationHttpResponse {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly status: number;
}

class PresentationRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PresentationRequestError';
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const ownProperty = (value: unknown, key: string): unknown => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const stringProperty = (value: unknown, key: string): string | undefined => {
  const property = ownProperty(value, key);
  return typeof property === 'string' && property.trim() ? property : undefined;
};

const errorCode = (error: unknown): string =>
  stringProperty(error, 'code') ?? 'PRESENTATION_INTERNAL_ERROR';

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return stringProperty(error, 'message') ?? 'Presentation request failed';
};

const errorPath = (error: unknown): string | undefined => stringProperty(error, 'path');

const errorDetails = (error: unknown): Record<string, string> | undefined => {
  const details: Record<string, string> = {};
  const source = ownProperty(error, 'details');
  if (isPlainObject(source)) {
    for (const key of ['jobId', 'artifactId', 'path']) {
      const value = stringProperty(source, key);
      if (value) details[key] = value;
    }
  }
  for (const key of ['jobId', 'artifactId']) {
    const value = stringProperty(error, key);
    if (value) details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
};

const statusForCode = (code: string): number => {
  if (code === 'PRESENTATION_INVALID' || code === 'TEMPLATE_INVALID') return 400;
  if (
    code === 'PRESENTATION_CONFLICT' ||
    code === 'PRESENTATION_TEMPLATE_INPUT_REQUIRED' ||
    code === 'PLUGIN_BUSY'
  )
    return 409;
  if (code === 'PRESENTATION_NOT_FOUND' || code === 'PRESENTATION_ROUTE_NOT_FOUND') return 404;
  if (code === 'PRESENTATION_CANCEL_FAILED') return 502;
  if (code === 'PRESENTATION_TIMEOUT') return 504;
  if (code === 'PRESENTATION_OUTPUT_LIMIT') return 413;
  if (code === 'PROVIDER_UNAVAILABLE') return 503;
  if (code === 'PPTX_INVALID') return 502;
  return 500;
};

export const presentationHttpErrorResponse = (error: unknown): PresentationHttpResponse => {
  const code = errorCode(error);
  const path = errorPath(error);
  const details = errorDetails(error);
  return {
    status: statusForCode(code),
    headers: JSON_HEADERS,
    body: {
      error: {
        code,
        message: errorMessage(error),
        ...(path ? { path } : {}),
        ...(details ? { details } : {}),
      },
    },
  };
};

const successResponse = (body: unknown): PresentationHttpResponse => ({
  status: 200,
  headers: JSON_HEADERS,
  body,
});

const pathSegments = (request: Request): string[] => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  const relativeSegments =
    presentationIndex >= 0 ? segments.slice(presentationIndex + 1) : segments;
  try {
    return relativeSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Path contains an invalid encoded segment',
      'path',
    );
  }
};

export const matchPresentationRoute = (request: Request): PresentationRouteMatch => {
  const segments = pathSegments(request);
  const method = request.method.toUpperCase();
  if (segments.length === 1 && segments[0] === 'templates') {
    if (method === 'GET') return { operation: 'templates' };
    if (method === 'POST') return { operation: 'learnTemplate' };
  }
  if (segments.length === 2 && segments[0] === 'templates' && method === 'DELETE')
    return { operation: 'deleteTemplate', id: segments[1] };
  if (
    segments.length === 2 &&
    segments[0] === 'templates' &&
    segments[1] === 'import' &&
    method === 'POST'
  )
    return { operation: 'importTemplate' };
  if (segments.length === 1 && segments[0] === 'tools' && method === 'GET')
    return { operation: 'tools' };
  if (segments.length === 2 && segments[0] === 'tools' && method === 'POST')
    return { operation: 'tool', id: segments[1] };
  if (segments.length === 1 && segments[0] === 'jobs' && method === 'POST') {
    return { operation: 'create' };
  }
  if (segments.length === 2 && segments[0] === 'jobs' && method === 'GET') {
    return { operation: 'get', id: segments[1] };
  }
  if (segments.length === 2 && segments[0] === 'jobs' && method === 'DELETE') {
    return { operation: 'deleteJob', id: segments[1] };
  }
  if (segments.length === 3 && segments[0] === 'jobs' && method === 'POST') {
    if (segments[2] === 'cancel') return { operation: 'cancel', id: segments[1] };
    if (segments[2] === 'retry') return { operation: 'retry', id: segments[1] };
    if (segments[2] === 'template') return { operation: 'applyTemplate', id: segments[1] };
    if (segments[2] === 'messages') return { operation: 'message', id: segments[1] };
  }
  if (segments.length === 2 && segments[0] === 'artifacts' && method === 'GET') {
    return { operation: 'getArtifact', id: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === 'artifacts' &&
    segments[2] === 'download' &&
    method === 'GET'
  ) {
    return { id: segments[1], operation: 'getArtifact', raw: true };
  }
  if (
    segments.length === 2 &&
    segments[0] === 'artifacts' &&
    segments[1] === 'export' &&
    method === 'POST'
  )
    return { operation: 'exportArtifact' };
  if (
    segments.length === 3 &&
    segments[0] === 'artifacts' &&
    segments[2] === 'export' &&
    method === 'POST'
  )
    return { operation: 'exportArtifact', id: segments[1] };
  return { operation: 'notFound' };
};

const readJsonObject = async (request: Request): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new PresentationRequestError('PRESENTATION_INVALID', 'Unable to read request body', '$');
  }
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Request body must be valid JSON',
      '$',
    );
  }
  if (!isPlainObject(value)) {
    throw new PresentationRequestError(
      'PRESENTATION_INVALID',
      'Request body must be an object',
      '$',
    );
  }
  return value;
};

const requiredId = (id: string | undefined, path: string): string => {
  if (typeof id !== 'string' || !id.trim()) {
    throw new PresentationRequestError('PRESENTATION_INVALID', `${path} must be non-empty`, path);
  }
  return id;
};

const isPresentationPort = (value: unknown): value is PresentationPort =>
  isRecord(value) &&
  typeof value.createJob === 'function' &&
  typeof value.getJob === 'function' &&
  typeof value.cancelJob === 'function' &&
  typeof value.retryJob === 'function' &&
  typeof value.getArtifact === 'function' &&
  typeof value.exportArtifact === 'function';

const isBinding = (value: unknown): value is PresentationPortBinding =>
  isRecord(value) && isPresentationPort(value.port);

const resolvePort = (value: unknown): PresentationPort => {
  if (isPresentationPort(value)) return value;
  if (isBinding(value)) return value.port;
  throw new PresentationRequestError(
    'PROVIDER_UNAVAILABLE',
    'Presentation factory did not provide a PresentationPort',
  );
};

const isPresentationFormat = (value: unknown): value is PresentationExportFormat =>
  value === 'pptx' || value === 'svg' || value === 'pdf' || value === 'quality-report';

const notFound = (kind: string, id: string): PresentationRequestError =>
  new PresentationRequestError(
    'PRESENTATION_NOT_FOUND',
    `${kind} does not exist: ${id}`,
    `${kind}Id`,
    {
      [`${kind}Id`]: id,
    },
  );

export const handlePresentationRequest = async (
  request: Request,
  scope: Omit<PresentationFactoryScope, 'request'>,
  match: PresentationRouteMatch,
  factory: PresentationPortFactory = getPresentationPortFactory(),
): Promise<PresentationHttpResponse> => {
  try {
    if (match.operation === 'notFound') {
      throw new PresentationRequestError(
        'PRESENTATION_ROUTE_NOT_FOUND',
        'Presentation route was not found',
      );
    }

    const result = await factory({ ...scope, request });
    const port = resolvePort(result);
    if (
      [
        'templates',
        'deleteTemplate',
        'learnTemplate',
        'importTemplate',
        'applyTemplate',
        'tools',
        'tool',
      ].includes(match.operation)
    ) {
      const extended = port as unknown as PresentationGenerationPort;
      if (typeof extended.listTemplates !== 'function')
        throw new PresentationRequestError(
          'PROVIDER_UNAVAILABLE',
          'Extended presentation capabilities are unavailable',
        );
      if (match.operation === 'templates')
        return successResponse({ templates: await extended.listTemplates() });
      if (match.operation === 'deleteTemplate') {
        if (typeof extended.deleteTemplate !== 'function')
          throw new PresentationRequestError(
            'PROVIDER_UNAVAILABLE',
            'Template deletion is unavailable',
          );
        const templateId = requiredId(match.id, 'templateId');
        await extended.deleteTemplate(templateId);
        return successResponse({ deleted: true, templateId });
      }
      if (match.operation === 'tools') return successResponse(await extended.listOperations());
      if (match.operation === 'importTemplate') {
        const form = await readPresentationUploadForm(request);
        const file = form.get('file');
        if (
          !file ||
          typeof file === 'string' ||
          !file.name.toLowerCase().endsWith('.pptx') ||
          file.size === 0 ||
          file.size > PRESENTATION_PPTX_MAX_UPLOAD_BYTES
        )
          throw new PresentationRequestError(
            'PRESENTATION_INVALID',
            `Upload a PPTX no larger than ${PRESENTATION_PPTX_MAX_UPLOAD_MIB} MiB`,
          );
        return successResponse(
          await extended.importTemplate(
            String(form.get('name') || file.name.replace(/\.pptx$/i, '')),
            new Uint8Array(await file.arrayBuffer()),
          ),
        );
      }
      const body = await readJsonObject(request);
      if (match.operation === 'learnTemplate')
        return successResponse(
          await extended.learnTemplate(
            String(body.name || ''),
            requiredId(body.jobId as string, 'jobId'),
          ),
        );
      if (match.operation === 'applyTemplate')
        return successResponse(
          await extended.applyTemplate(
            requiredId(match.id, 'jobId'),
            body as unknown as Parameters<typeof extended.applyTemplate>[1],
          ),
        );
      if (match.operation === 'tool')
        return successResponse(await extended.executeOperation(requiredId(match.id, 'name'), body));
    }
    if (match.operation === 'create') {
      const input = (await readJsonObject(request)) as unknown as PresentationJobInput;
      return successResponse(await port.createJob(input));
    }

    if (match.operation === 'exportArtifact') {
      const body = await readJsonObject(request);
      const artifactId =
        match.id ?? (typeof body.artifactId === 'string' ? body.artifactId : undefined);
      const id = requiredId(artifactId, 'artifactId');
      const queryFormat = new URL(request.url).searchParams.get('format') ?? undefined;
      const format = body.format ?? queryFormat;
      if (!isPresentationFormat(format)) {
        throw new PresentationRequestError(
          'PRESENTATION_INVALID',
          'format must be one of pptx, svg, pdf, quality-report',
          'format',
        );
      }
      return successResponse((await port.exportArtifact(id, format)) as ExportResult);
    }

    const id = requiredId(match.id, match.operation === 'getArtifact' ? 'artifactId' : 'jobId');
    if (match.operation === 'get') {
      const job = await port.getJob(id);
      if (!job) throw notFound('job', id);
      return successResponse(job);
    }
    if (match.operation === 'deleteJob') {
      const deleting = port as typeof port & { deleteJob?: (jobId: string) => Promise<void> };
      if (!deleting.deleteJob)
        throw new PresentationRequestError(
          'PROVIDER_UNAVAILABLE',
          'Presentation deletion is unavailable',
        );
      await deleting.deleteJob(id);
      return successResponse({ deleted: true, jobId: id });
    }
    if (match.operation === 'cancel') return successResponse(await port.cancelJob(id));
    if (match.operation === 'retry') return successResponse(await port.retryJob(id));
    if (match.operation === 'message') {
      const messaging = port as typeof port & {
        sendMessage?: (jobId: string, input: PresentationMessageInput) => Promise<PresentationJob>;
      };
      if (!messaging.sendMessage)
        throw new PresentationRequestError(
          'PROVIDER_UNAVAILABLE',
          'Presentation messages are not available',
        );
      return successResponse(
        await messaging.sendMessage(
          id,
          (await readJsonObject(request)) as unknown as PresentationMessageInput,
        ),
      );
    }
    if (match.operation === 'getArtifact') {
      const isRaw =
        match.raw ||
        request.headers.get('accept') === 'application/octet-stream' ||
        new URL(request.url).searchParams.get('download') === 'true' ||
        new URL(request.url).searchParams.get('raw') === 'true';

      if (isRaw && typeof (port as any).getRawArtifact === 'function') {
        const raw = await (port as any).getRawArtifact(id);
        if (!raw || !raw.bytes) throw notFound('artifact', id);
        return {
          body: raw.bytes,
          headers: {
            'content-disposition': `attachment; filename="${encodeURIComponent(raw.name)}"`,
            'content-type': raw.mimeType,
          },
          status: 200,
        };
      }

      const artifact = await port.getArtifact(id);
      if (!artifact) throw notFound('artifact', id);
      return successResponse(artifact as ArtifactSnapshot);
    }
    throw new PresentationRequestError(
      'PRESENTATION_ROUTE_NOT_FOUND',
      'Presentation route was not found',
    );
  } catch (error) {
    return presentationHttpErrorResponse(error);
  }
};
