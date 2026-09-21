import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { auth } from '@/auth';
import { session as authSessions } from '@/database/schemas/betterAuth';
import type { LobeChatDatabase } from '@/database/type';
import {
  migratePresentationSessions,
  presentationAccountScope,
} from '@/server/runtime/presentation/account-workspace';
import { createPresentationArtifactAssetStoreBridge } from '@/server/runtime/presentation/asset-store';
import { uploadPresentationAttachment } from '@/server/runtime/presentation/attachment-storage';
import type { PresentationRuntimeComposition } from '@/server/runtime/presentation/composition';
import { createPresentationContextServices } from '@/server/runtime/presentation/context-services';
import { createPresentationContextRuntime } from '@/server/runtime/presentation/context-tools';
import { conversationStream } from '@/server/runtime/presentation/conversation-stream';
import {
  createPresentationRouteJournalBindings,
  ScopedPresentationJobEventJournalCache,
} from '@/server/runtime/presentation/event-journal-cache';
import {
  createScopedPresentationPortCache,
  getPresentationPortFactory,
  type PresentationFactoryScope,
  type PresentationPortFactory,
  presentationPortFactoryFromScopeCache,
  type PresentationPortScopeCacheBinding,
} from '@/server/runtime/presentation/factory';
import { FilePresentationStorage } from '@/server/runtime/presentation/file-storage';
import type { PresentationGenerationCapability } from '@/server/runtime/presentation/generation-capability';
import {
  handlePresentationGenerationRequest,
  type PresentationGenerationEventPublisherFactory as GenerationEventPublisherFactory,
} from '@/server/runtime/presentation/generation-handler';
import {
  handlePresentationRequest,
  matchPresentationRoute,
} from '@/server/runtime/presentation/handler';
import { createPresentationImageGenerationEventPublisher } from '@/server/runtime/presentation/image-event-bridge';
import type { ImageGenerationCapability } from '@/server/runtime/presentation/image-generation-capability';
import { createImageGenerationCapability } from '@/server/runtime/presentation/image-generation-capability';
import { handleImageGenerationRequest } from '@/server/runtime/presentation/image-generation-handler';
import { type PresentationJobEventJournalPort } from '@/server/runtime/presentation/job-event-journal';
import { createResilientMultimodalChatPort } from '@/server/runtime/presentation/multimodal-chat-fallback';
import type { PresentationPipelineContext } from '@/server/runtime/presentation/pipeline';
import type { ProductionProviderReadiness } from '@/server/runtime/presentation/production-command';
import { PRODUCTION_PRESENTATION_ENV_KEYS } from '@/server/runtime/presentation/production-config';
import {
  createPptMasterProcessRunnerFactory,
  createPptMasterProductionPresentationComposition,
  createProductionPresentationGenerationComposition,
  type PptMasterPresentationScope,
} from '@/server/runtime/presentation/production-factory';
import {
  createProductionOpenAIImageGenerationPort,
  PRODUCTION_IMAGE_ENV_KEYS,
} from '@/server/runtime/presentation/production-image-config';
import {
  createProductionMultimodalChatPort,
  PRODUCTION_CHAT_ENV_KEYS,
} from '@/server/runtime/presentation/production-multimodal-chat-config';
import { createPresentationChatFetch } from '@/server/runtime/presentation/resilient-fetch';
import { createProcessPresentationRunner } from '@/server/runtime/presentation/runner';
import {
  createPresentationJobEventSseResponse,
  type PresentationJobEventSerializer,
} from '@/server/runtime/presentation/sse';
import { FilePresentationTemplateLibrary } from '@/server/runtime/presentation/templates';
import { createOpenAICompatibleAudioTranscriber } from '@/server/runtime/presentation/templates/audio-transcription';
import { PptMasterToolchain } from '@/server/runtime/presentation/toolchain';

import type { RuntimeScope } from '../../../../../../../packages/runtime-contracts/src';

interface PresentationAuthScope {
  readonly serverDB: unknown;
  readonly userId: string;
}

type PresentationScopedHandler = (
  request: Request,
  scope: PresentationAuthScope,
) => Promise<Response>;

type PresentationGuardedHandler = (request: Request, options?: unknown) => Promise<Response>;

export type PresentationAuthBoundary = (
  handler: PresentationScopedHandler,
) => PresentationGuardedHandler;

export type PresentationGenerationScopeFactory = (
  request: Request,
  authenticated: PresentationAuthScope,
) => RuntimeScope | Promise<RuntimeScope>;

export type PresentationGenerationContextFactory = (jobId: string) => PresentationPipelineContext;

export type PresentationGenerationEventPublisherFactory = GenerationEventPublisherFactory;

export interface PresentationJobEventJournalFactoryScope extends PresentationAuthScope {
  readonly request: Request;
}

export type PresentationJobEventJournalFactory = (
  scope: PresentationJobEventJournalFactoryScope,
) =>
  | PresentationJobEventJournalPort
  | undefined
  | Promise<PresentationJobEventJournalPort | undefined>;

/**
 * Reads the authenticated session id for scoped-cache adoption. Default source
 * is the `x-session-id` header; deployments with their own session resolution
 * should override it explicitly.
 */
export type PresentationSessionIdFor = (request: Request) => string | undefined;

const defaultSessionIdFor: PresentationSessionIdFor = (request) =>
  request.headers.get('x-session-id') ?? undefined;

/** C-73 readiness result or an explicitly injected, server-only resolver. */
export type PresentationReadinessSource =
  | ProductionProviderReadiness
  | (() => ProductionProviderReadiness | Promise<ProductionProviderReadiness>);

/** C-77 production composition projection consumed by the readiness route. */
export interface PresentationProductionReadinessComposition {
  readonly readiness?: PresentationReadinessSource;
}

export interface PresentationRouteOptions {
  readonly authenticate?: PresentationAuthBoundary;
  /** C-70 explicit presentation composition; individual seam options conflict with it. */
  readonly composition?: PresentationRuntimeComposition;
  /** C-59 fake/provider seam; production must inject a real server capability. */
  readonly generationCapability?: PresentationGenerationCapability;
  /** C-59 pipeline context seam; it must not be created from client headers. */
  readonly generationContextFactory?: PresentationGenerationContextFactory;
  /** C-65 server-only publisher seam for generation job events. */
  readonly generationEventPublisherFactory?: PresentationGenerationEventPublisherFactory;
  /** Resolves the authenticated server-side generation scope. */
  readonly generationScopeFactory?: PresentationGenerationScopeFactory;
  /** C-91 fake/provider seam; production must inject a real server capability. */
  readonly imageGenerationCapability?: ImageGenerationCapability;
  /** Injectable heartbeat interval for deterministic SSE tests. */
  readonly jobEventHeartbeatIntervalMs?: number;
  /** C-61 server-only journal binding; absent means the SSE seam is unavailable. */
  readonly jobEventJournal?: PresentationJobEventJournalPort;
  /** Scope-aware journal factory for production/test wiring. */
  readonly jobEventJournalFactory?: PresentationJobEventJournalFactory;
  /** Injectable wire serializer for journal SSE tests. */
  readonly jobEventSerializer?: PresentationJobEventSerializer;
  readonly portFactory?: PresentationPortFactory;
  /** C-77 production composition; readiness is the only route-level projection used here. */
  readonly productionComposition?: PresentationProductionReadinessComposition;
  /** Direct C-73 readiness seam; never inferred from process.env or request headers. */
  readonly readiness?: PresentationReadinessSource;
  /**
   * C-27: explicit adoption of the C-25 scoped cache. When present, the route
   * resolves ports through it (reusing one port per authenticated
   * `{ userId, sessionId }` scope) and `portFactory` must be omitted — the
   * binding owns the underlying factory. Absent → current uncached behavior.
   */
  readonly scopeCache?: PresentationPortScopeCacheBinding;
  /** Session-id source used only while `scopeCache` is configured. */
  readonly sessionIdFor?: PresentationSessionIdFor;
}

const defaultAuthBoundary: PresentationAuthBoundary = (handler) => {
  const guarded = checkAuth(async (request, { userId, serverDB }) =>
    handler(request, { userId, serverDB }),
  );

  return (request, options) =>
    guarded(request, options as { params: Promise<{ provider?: string }> });
};

const generationPath = (request: Request): boolean => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  return segments.slice(presentationIndex + 1).join('/') === 'generation';
};

const imageGenerationPath = (request: Request): boolean => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  return segments.slice(presentationIndex + 1).join('/') === 'image-generation';
};

const outlinePath = (request: Request): boolean => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  return segments.slice(presentationIndex + 1).join('/') === 'outline';
};

const conversationPath = (request: Request): boolean => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  return segments.slice(presentationIndex + 1).join('/') === 'conversation';
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const generationErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code;
  }
  return 'PRESENTATION_INTERNAL_ERROR';
};

const generationErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Presentation generation failed';
};

const generationStatusForCode = (code: string): number => {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN' || code === 'PRESENTATION_EVENT_SCOPE_DENIED') return 403;
  if (code === 'PRESENTATION_INVALID' || code === 'PRESENTATION_COMPOSITION_OPTIONS_INVALID') {
    return 400;
  }
  if (code === 'PRESENTATION_TEMPLATE_INPUT_REQUIRED') return 409;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'PRESENTATION_QUALITY_FAILED' || code === 'PPTX_INVALID') return 502;
  if (code === 'PRESENTATION_WORKER_CANCELLED') return 499;
  if (code === 'IMAGE_PLAN_INVALID') return 400;
  if (code === 'IMAGE_BUDGET_EXCEEDED') return 429;
  if (code === 'IMAGE_CANCELLED') return 499;
  if (code === 'IMAGE_UNAVAILABLE') return 503;
  if (code === 'PROVIDER_UNAVAILABLE') return 503;
  return 500;
};

const generationScopeError = (code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string): Error =>
  Object.assign(new Error(message), { code });

const serverSessionHeaders = (request: Request): Headers => {
  const headers = new Headers(request.headers);
  // These are presentation-cache conventions, never authentication inputs.
  headers.delete('x-session-id');
  headers.delete('session');
  headers.delete('x-session');
  return headers;
};

const accountMigrations = new Map<string, Promise<unknown>>();

const defaultGenerationScopeFactory: PresentationGenerationScopeFactory = async (
  request,
  authenticated,
) => {
  const session = await auth.api.getSession({ headers: serverSessionHeaders(request) });
  const sessionUserId = session?.user?.id;
  const sessionId = session?.session?.id;
  if (
    typeof sessionUserId !== 'string' ||
    sessionUserId.trim().length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.trim().length === 0
  ) {
    throw generationScopeError('UNAUTHORIZED', 'An authenticated server session is required');
  }
  if (sessionUserId !== authenticated.userId) {
    throw generationScopeError(
      'FORBIDDEN',
      'Authenticated session user does not match request user',
    );
  }
  // Authentication stays session-bound; documents and execution coordination belong to the account.
  if (!accountMigrations.has(sessionUserId)) {
    const migration = (async () => {
      const db = authenticated.serverDB as LobeChatDatabase | undefined;
      const verified =
        typeof db?.select === 'function'
          ? await db
              .select({ id: authSessions.id })
              .from(authSessions)
              .where(eq(authSessions.userId, sessionUserId))
          : [];
      await migratePresentationSessions(
        process.env.CORDIS_PRESENTATION_DATA_DIR ??
          nodePath.join(process.cwd(), '.data', 'presentation'),
        sessionUserId,
        [sessionId, ...verified.map((row) => row.id)],
      );
    })();
    accountMigrations.set(sessionUserId, migration);
    migration.catch(() => accountMigrations.delete(sessionUserId));
  }
  await accountMigrations.get(sessionUserId);
  return { ...presentationAccountScope(sessionUserId), serverDB: authenticated.serverDB };
};

/**
 * Server startup wiring for the real ppt-master worker. Configuration is
 * projected into the C-75 env-like record once; the composition itself still
 * remains side-effect free and no process is spawned until createJob().
 */
let configuredDefaultReadiness: ProductionProviderReadiness | undefined;
let configuredDefaultReadinessError: unknown;

const defaultProductionPortFactory = (): PresentationPortFactory => {
  const root = process.env.CORDIS_PPT_MASTER_ROOT;
  const runnerPath = process.env.CORDIS_PPT_RUNNER;
  if (!root || !runnerPath) return getPresentationPortFactory();

  const env = {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.provider] ?? 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.command] ??
      JSON.stringify([process.env.CORDIS_PPT_PYTHON ?? 'python3', runnerPath]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.runnerId] ?? 'ppt-master-runner',
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds] ??
      JSON.stringify(['ppt-master-runner']),
  } as const;

  try {
    const composition = createPptMasterProductionPresentationComposition({
      env,
      runnerFactory: createPptMasterProcessRunnerFactory({
        pptMasterRoot: root,
      }),
    });
    configuredDefaultReadiness = process.env[PRODUCTION_CHAT_ENV_KEYS.apiKey]
      ? composition.readiness
      : {
          available: false,
          commandAvailable: false,
          code: 'PROVIDER_UNAVAILABLE',
          provider: composition.readiness.provider,
          runnerId: composition.readiness.runnerId,
          state: 'unavailable',
        };
    const scopedCache = createScopedPresentationPortCache({
      factory: async (scope) => composition.portFactory(scope as PptMasterPresentationScope),
    });
    return async (scope) => {
      // checkAuth authenticates the user but intentionally does not expose a
      // client-controlled session id. Resolve it from the server session.
      const session = await auth.api.getSession({ headers: serverSessionHeaders(scope.request) });
      const sessionId = session?.session?.id;
      if (!sessionId || session.user?.id !== scope.userId) {
        throw Object.assign(new Error('An authenticated server session is required'), {
          code: 'UNAUTHORIZED',
        });
      }
      return scopedCache.resolve({
        userId: scope.userId,
        sessionId,
        request: scope.request,
        serverDB: scope.serverDB,
      });
    };
  } catch (error) {
    // Keep malformed configuration observable as PRESENTATION_INVALID instead
    // of silently downgrading it to an unavailable provider.
    configuredDefaultReadinessError = error;
    return async () => {
      throw error;
    };
  }
};

const createDefaultGenerationContextFactory = (
  pptMasterRoot: string,
  pythonCommand: string,
): PresentationGenerationContextFactory => {
  const runnerId = 'ppt-master-generation-toolchain';
  const runner = createProcessPresentationRunner({
    command: [pythonCommand],
    declareArtifacts: (request) =>
      request.operation === 'export' ? ['exports/presentation.pptx'] : [],
    id: runnerId,
    maxArtifacts: 64,
  });
  const scriptsRoot = nodePath.join(pptMasterRoot, 'skills', 'ppt-master', 'scripts');
  const toolchain = new PptMasterToolchain({
    allowedRunnerIds: [runnerId],
    convertScriptPath: nodePath.join(scriptsRoot, 'svg_to_pptx.py'),
    providerCommand: [pythonCommand],
    pptMasterRoot,
    qualityScriptPath: nodePath.join(scriptsRoot, 'svg_quality_checker.py'),
    runner,
    runnerId,
    timeoutMs: 120_000,
    workspaceRoot: tmpdir(),
  });

  return (jobId) => {
    const safeJobId = jobId.replaceAll(/[^\w-]/g, '_');
    const workspacePath = nodePath.join(tmpdir(), `lobehub-presentation-generation-${safeJobId}`);
    return {
      plannerContext: {},
      workerContext: {
        convert: (path, signal) => toolchain.convert(path, signal),
        jobId,
        qualityCheck: (path, signal) => toolchain.qualityCheck(path, signal),
        workspace: {
          cleanup: () => rm(workspacePath, { force: true, recursive: true }),
          path: workspacePath,
          write: async (relativePath, content) => {
            const target = nodePath.join(workspacePath, relativePath);
            await mkdir(nodePath.dirname(target), { recursive: true });
            await writeFile(target, content);
          },
        },
      },
    };
  };
};

const defaultProductionGenerationComposition = (): PresentationRuntimeComposition | undefined => {
  const root = process.env.CORDIS_PPT_MASTER_ROOT;
  const runnerPath = process.env.CORDIS_PPT_RUNNER;
  // The presentation planner uses one provider-neutral, OpenAI-compatible
  // multimodal endpoint. Retired BAI/GLM variables are intentionally ignored.
  const chatApiKey = process.env[PRODUCTION_CHAT_ENV_KEYS.apiKey];
  const imageApiKey = process.env[PRODUCTION_IMAGE_ENV_KEYS.apiKey];

  // If the presentation runner (ppt-master) is not configured, do not assemble
  // a half-baked composition that cannot produce presentation output. Fail-closed
  // with PROVIDER_UNAVAILABLE.
  if (!root || !runnerPath) {
    return undefined;
  }

  const pptEnv = {
    [PRODUCTION_PRESENTATION_ENV_KEYS.provider]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.provider] ?? 'ppt-master',
    [PRODUCTION_PRESENTATION_ENV_KEYS.command]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.command] ??
      JSON.stringify([process.env.CORDIS_PPT_PYTHON ?? 'python3', runnerPath]),
    [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.runnerId] ?? 'ppt-master-runner',
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]:
      process.env[PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds] ??
      JSON.stringify(['ppt-master-runner']),
  } as const;

  const chatEnv = {
    [PRODUCTION_CHAT_ENV_KEYS.apiKey]: chatApiKey,
    [PRODUCTION_CHAT_ENV_KEYS.baseUrl]: process.env[PRODUCTION_CHAT_ENV_KEYS.baseUrl],
    [PRODUCTION_CHAT_ENV_KEYS.model]: process.env[PRODUCTION_CHAT_ENV_KEYS.model],
  } as const;

  const imgEnv = {
    [PRODUCTION_IMAGE_ENV_KEYS.apiKey]: imageApiKey,
    [PRODUCTION_IMAGE_ENV_KEYS.baseUrl]: process.env[PRODUCTION_IMAGE_ENV_KEYS.baseUrl],
    [PRODUCTION_IMAGE_ENV_KEYS.model]: process.env[PRODUCTION_IMAGE_ENV_KEYS.model],
  } as const;

  try {
    const dataRoot =
      process.env.CORDIS_PRESENTATION_DATA_DIR ??
      nodePath.join(process.cwd(), '.data', 'presentation');
    const artifactStore = new FilePresentationStorage(dataRoot);
    const assetStore = createPresentationArtifactAssetStoreBridge(artifactStore);
    const journalCache = new ScopedPresentationJobEventJournalCache({
      load: async (scope) => artifactStore.createJournal(scope),
    });
    const journalBindings = createPresentationRouteJournalBindings(journalCache);

    const primaryMultimodalChatPort = chatApiKey
      ? createProductionMultimodalChatPort({
          env: chatEnv,
          fetcher: createPresentationChatFetch(globalThis.fetch),
        })
      : undefined;
    const multimodalChatPort = primaryMultimodalChatPort
      ? createResilientMultimodalChatPort(primaryMultimodalChatPort)
      : undefined;

    const imageGenerationCapability = imageApiKey
      ? createImageGenerationCapability({
          assetStore,
          eventPublisherFactory: async (scope, jobId) =>
            createPresentationImageGenerationEventPublisher({
              publisher: await journalBindings.generationEventPublisherFactory(
                scope,
                jobId,
                new Request('http://presentation.internal/image-generation'),
              ),
              scope,
            }),
          imagePort: createProductionOpenAIImageGenerationPort(imgEnv, {
            assetSink: async ({ bytes, metadata, scope }) => {
              const artifactId = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
              const stored = await assetStore.put(scope, {
                asset: { ref: artifactId },
                bytes,
                idempotencyKey: artifactId,
                metadata,
              });
              return stored.asset;
            },
            fetcher: globalThis.fetch,
          }),
        })
      : undefined;

    const runnerFactory = createPptMasterProcessRunnerFactory({ pptMasterRoot: root });
    const contextFactory = createDefaultGenerationContextFactory(
      root,
      process.env.CORDIS_PPT_PYTHON ?? 'python3',
    );

    let audioTranscriber: ReturnType<typeof createOpenAICompatibleAudioTranscriber> | undefined;
    const transcriptionApiKey = process.env.OPENAI_API_KEY?.trim();
    const transcriptionBaseUrl = process.env.OPENAI_BASE_URL?.trim();
    if (transcriptionApiKey && transcriptionBaseUrl) {
      try {
        audioTranscriber = createOpenAICompatibleAudioTranscriber({
          apiKey: transcriptionApiKey,
          baseUrl: transcriptionBaseUrl,
          fetcher: globalThis.fetch,
          model: process.env.PRESENTATION_AUDIO_TRANSCRIPTION_MODEL,
        });
      } catch {
        // Optional STT must not make the presentation runtime unavailable.
      }
    }

    const result = createProductionPresentationGenerationComposition({
      audioTranscriber,
      templateLibrary: new FilePresentationTemplateLibrary({
        root: nodePath.join(dataRoot, 'templates'),
      }),
      artifactStore,
      jobRepository: artifactStore,
      contextFactory,
      env: pptEnv,
      imageGenerationCapability,
      journalCache,
      multimodalChatPort,
      runnerFactory,
    });

    if (configuredDefaultReadiness === undefined) {
      configuredDefaultReadiness = multimodalChatPort
        ? result.readiness
        : {
            available: false,
            commandAvailable: false,
            code: 'PROVIDER_UNAVAILABLE',
            provider: result.readiness.provider,
            runnerId: result.readiness.runnerId,
            state: 'unavailable',
          };
    }

    return result.composition;
  } catch (error) {
    if (configuredDefaultReadinessError === undefined) {
      configuredDefaultReadinessError = error;
    }
    return undefined;
  }
};

const configuredDefaultComposition = defaultProductionGenerationComposition();

const configuredDefaultPortFactory = defaultProductionPortFactory();

const unavailableGenerationCapability: PresentationGenerationCapability = {
  execute: async () => {
    throw Object.assign(new Error('Presentation generation provider is not configured'), {
      code: 'PROVIDER_UNAVAILABLE',
    });
  },
} as unknown as PresentationGenerationCapability;

const unavailableGenerationContextFactory: PresentationGenerationContextFactory = () => {
  throw Object.assign(new Error('Presentation generation provider is not configured'), {
    code: 'PROVIDER_UNAVAILABLE',
  });
};

const generationErrorResponse = (error: unknown): Response => {
  const code = generationErrorCode(error);
  return NextResponse.json(
    { error: { code, message: generationErrorMessage(error) } },
    { status: generationStatusForCode(code) },
  );
};

const compositionConfigurationError = (message: string, path?: string): Error =>
  Object.assign(new Error(message), {
    code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID',
    ...(path ? { path } : {}),
  });

const isPresentationRuntimeComposition = (
  value: unknown,
): value is PresentationRuntimeComposition =>
  Boolean(
    value &&
    typeof value === 'object' &&
    'generationHandler' in value &&
    typeof value.generationHandler === 'function' &&
    'jobEventJournalFactory' in value &&
    typeof value.jobEventJournalFactory === 'function' &&
    'generationEventPublisherFactory' in value &&
    typeof value.generationEventPublisherFactory === 'function' &&
    'reset' in value &&
    typeof value.reset === 'function' &&
    'dispose' in value &&
    typeof value.dispose === 'function',
  );

const compositionConflictPath = (options: PresentationRouteOptions): string | undefined => {
  if (options.composition === undefined) return;
  const conflictingKeys = [
    'generationCapability',
    'imageGenerationCapability',
    'generationContextFactory',
    'generationEventPublisherFactory',
    'jobEventJournal',
    'jobEventJournalFactory',
    'portFactory',
    'scopeCache',
  ] as const;
  return conflictingKeys.find((key) => options[key] !== undefined);
};

const rawPresentationPathSegments = (request: Request): string[] => {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const presentationIndex = segments.lastIndexOf('presentation');
  return presentationIndex >= 0 ? segments.slice(presentationIndex + 1) : segments;
};

export const isPresentationReadinessRequest = (request: Request): boolean =>
  request.method.toUpperCase() === 'GET' &&
  rawPresentationPathSegments(request).length === 1 &&
  rawPresentationPathSegments(request)[0] === 'readiness';

const readinessErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code;
  }
  return 'PRESENTATION_INVALID';
};

const readinessErrorPath = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'path' in error) {
    const path = (error as { path?: unknown }).path;
    return typeof path === 'string' && path.trim() ? path : undefined;
  }
  return;
};

const readinessStatusForCode = (code: string): number => {
  if (code === 'PROVIDER_UNAVAILABLE') return 503;
  if (code === 'PRESENTATION_INVALID' || code === 'PRESENTATION_RUNNER_NOT_ALLOWED') return 400;
  return 500;
};

const readinessErrorResponse = (error: unknown): Response => {
  const code = readinessErrorCode(error);
  const path = readinessErrorPath(error);
  const message =
    code === 'PROVIDER_UNAVAILABLE'
      ? 'Presentation provider is not configured'
      : code === 'PRESENTATION_INVALID' || code === 'PRESENTATION_RUNNER_NOT_ALLOWED'
        ? 'Presentation provider configuration is invalid'
        : 'Presentation provider readiness failed';
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(path ? { path } : {}),
      },
    },
    { status: readinessStatusForCode(code) },
  );
};

const invalidReadiness = (message: string, path = 'readiness'): Error =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID', path });

const isReadinessState = (value: unknown): value is ProductionProviderReadiness['state'] =>
  value === 'configured' || value === 'unavailable';

/** Copy only C-73 safe fields; arbitrary injected keys never reach the wire. */
const projectReadiness = (value: unknown): ProductionProviderReadiness => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidReadiness('Readiness must be an object');
  }
  const record = value as Record<string, unknown>;
  const available = record.available;
  const commandAvailable = record.commandAvailable;
  const state = record.state;
  if (
    typeof available !== 'boolean' ||
    typeof commandAvailable !== 'boolean' ||
    !isReadinessState(state) ||
    available !== commandAvailable ||
    available !== (state === 'configured')
  ) {
    throw invalidReadiness('Readiness contains an invalid state', 'readiness.state');
  }
  const provider = record.provider;
  if (provider !== undefined && !nonEmptyString(provider)) {
    throw invalidReadiness('provider must be a non-empty string', 'readiness.provider');
  }
  const runnerId = record.runnerId;
  if (runnerId !== undefined && !nonEmptyString(runnerId)) {
    throw invalidReadiness('runnerId must be a non-empty string', 'readiness.runnerId');
  }
  const code = record.code;
  if (code !== undefined && code !== 'PROVIDER_UNAVAILABLE') {
    throw invalidReadiness('readiness.code is invalid', 'readiness.code');
  }
  return {
    available,
    commandAvailable,
    state,
    ...(provider !== undefined ? { provider } : {}),
    ...(runnerId !== undefined ? { runnerId } : {}),
    ...(code !== undefined ? { code } : {}),
  };
};

const readinessSourceFor = (
  options: PresentationRouteOptions,
): PresentationReadinessSource | undefined => {
  const direct = options.readiness;
  const composed = options.productionComposition;
  if (
    composed !== undefined &&
    (!composed || typeof composed !== 'object' || Array.isArray(composed))
  ) {
    throw invalidReadiness('productionComposition must be an object', 'productionComposition');
  }
  const compositionReadiness = composed?.readiness;
  if (direct !== undefined && compositionReadiness !== undefined) {
    throw invalidReadiness(
      'Provide readiness or productionComposition.readiness, not both',
      'readiness',
    );
  }
  if (direct !== undefined || compositionReadiness !== undefined) {
    return direct ?? compositionReadiness;
  }
  if (configuredDefaultReadinessError !== undefined) {
    return () => {
      throw configuredDefaultReadinessError;
    };
  }
  return configuredDefaultReadiness;
};

const toReadinessResponse = async (options: PresentationRouteOptions): Promise<Response> => {
  try {
    const source = readinessSourceFor(options);
    if (source === undefined) {
      throw Object.assign(new Error('Presentation provider readiness is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    const value = typeof source === 'function' ? await source() : source;
    const readiness = projectReadiness(value);
    return NextResponse.json(readiness, {
      status: readiness.available ? 200 : 503,
    });
  } catch (error) {
    return readinessErrorResponse(error);
  }
};

export const isPresentationJobEventsRequest = (request: Request): boolean => {
  const segments = rawPresentationPathSegments(request);
  return (
    request.method.toUpperCase() === 'GET' &&
    segments.length === 3 &&
    segments[0] === 'jobs' &&
    segments[2] === 'events' &&
    Boolean(segments[1])
  );
};

export const presentationJobEventsPath = (request: Request): string | undefined => {
  if (!isPresentationJobEventsRequest(request)) return;
  const segments = rawPresentationPathSegments(request);
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    throw Object.assign(new Error('Path contains an invalid encoded segment'), {
      code: 'PRESENTATION_INVALID',
      path: 'jobId',
    });
  }
};

const jobEventErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code;
  }
  return 'PRESENTATION_INTERNAL_ERROR';
};

const jobEventErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Presentation job events request failed';
};

const jobEventErrorPath = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'path' in error) {
    const path = (error as { path?: unknown }).path;
    return typeof path === 'string' && path.trim() ? path : undefined;
  }
  return;
};

const jobEventStatusForCode = (code: string): number => {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'PRESENTATION_INVALID' || code === 'PRESENTATION_EVENT_INVALID') return 400;
  if (code === 'PRESENTATION_EVENT_SEQ_INVALID') return 400;
  if (
    code === 'FORBIDDEN' ||
    code === 'PRESENTATION_SCOPE_DENIED' ||
    code === 'PRESENTATION_EVENT_SCOPE_DENIED'
  )
    return 403;
  if (code === 'NOT_FOUND' || code === 'PRESENTATION_NOT_FOUND') return 404;
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'PRESENTATION_EVENT_JOURNAL_DISPOSED') return 503;
  return 500;
};

const jobEventErrorResponse = (error: unknown): Response => {
  const code = jobEventErrorCode(error);
  const path = jobEventErrorPath(error);
  return NextResponse.json(
    {
      error: {
        code,
        message: jobEventErrorMessage(error),
        ...(path ? { path } : {}),
      },
    },
    { status: jobEventStatusForCode(code) },
  );
};

const afterSeqFromRequest = (request: Request): number => {
  const values = new URL(request.url).searchParams.getAll('after_seq');
  if (values.length === 0) return -1;
  const raw = values[0];
  if (!raw || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw Object.assign(new Error('after_seq must be a non-negative safe integer'), {
      code: 'PRESENTATION_INVALID',
      path: 'after_seq',
    });
  }
  const afterSeq = Number(raw);
  if (!Number.isSafeInteger(afterSeq)) {
    throw Object.assign(new Error('after_seq must be a non-negative safe integer'), {
      code: 'PRESENTATION_INVALID',
      path: 'after_seq',
    });
  }
  if (values.length > 1) {
    throw Object.assign(new Error('after_seq must be provided at most once'), {
      code: 'PRESENTATION_INVALID',
      path: 'after_seq',
    });
  }
  return afterSeq;
};

const serverScopedRequest = (request: Request): Request =>
  new Request(request, { headers: serverSessionHeaders(request) });

const toJobEventResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  options: PresentationRouteOptions,
  composition: PresentationRuntimeComposition | undefined,
  generationScopeFactory: PresentationGenerationScopeFactory,
): Promise<Response> => {
  try {
    const jobId = presentationJobEventsPath(request);
    if (!jobId) {
      throw Object.assign(new Error('Presentation job events route was not found'), {
        code: 'PRESENTATION_NOT_FOUND',
      });
    }
    const afterSeq = afterSeqFromRequest(request);
    const journal = composition
      ? await (async () => {
          const resolvedScope = await generationScopeFactory(request, authenticated);
          if (
            !resolvedScope ||
            resolvedScope.userId !== authenticated.userId ||
            !nonEmptyString(resolvedScope.sessionId)
          ) {
            throw Object.assign(new Error('Presentation event scope is invalid'), {
              code: 'PRESENTATION_SCOPE_DENIED',
              path: 'scope',
            });
          }
          return await composition.jobEventJournalFactory(resolvedScope, {
            request: serverScopedRequest(request),
          });
        })()
      : options.jobEventJournalFactory
        ? await options.jobEventJournalFactory({
            ...authenticated,
            request: serverScopedRequest(request),
          })
        : options.jobEventJournal;
    if (!journal) {
      throw Object.assign(new Error('Presentation event journal is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    if (journal.scope && journal.scope.userId !== authenticated.userId) {
      throw Object.assign(new Error('Presentation job does not belong to the authenticated user'), {
        code: 'PRESENTATION_SCOPE_DENIED',
        path: 'jobId',
      });
    }
    const known = typeof journal.has === 'function' ? journal.has(jobId) : undefined;
    const events = journal.replay(jobId, afterSeq);
    if (known === false || (known === undefined && events.length === 0)) {
      throw Object.assign(new Error(`Presentation job does not exist: ${jobId}`), {
        code: 'PRESENTATION_NOT_FOUND',
        path: 'jobId',
      });
    }
    const stream = createPresentationJobEventSseResponse(
      events,
      request.signal,
      {
        ...(options.jobEventHeartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: options.jobEventHeartbeatIntervalMs }
          : {}),
        ...(options.jobEventSerializer ? { serializer: options.jobEventSerializer } : {}),
        subscribe: (listener, subscribeOptions) =>
          journal.subscribe(jobId, listener, subscribeOptions),
      },
      afterSeq,
    );
    return new Response(stream.body, {
      headers: stream.headers,
      status: stream.status,
    });
  } catch (error) {
    return jobEventErrorResponse(error);
  }
};

const toNextResponse = async (
  request: Request,
  scope: Omit<PresentationFactoryScope, 'request'>,
  portFactory: PresentationPortFactory,
  composition?: PresentationRuntimeComposition,
  generationScopeFactory?: PresentationGenerationScopeFactory,
): Promise<Response> => {
  // The async generation bridge is the canonical `/jobs` path when a full
  // Cordis composition is installed. Legacy portFactory remains the fallback
  // for compatibility and for deployments that only expose ppt-master.
  let resolvedFactory = portFactory;
  if (composition?.generationPortFactory && generationScopeFactory) {
    const generationScope = await generationScopeFactory(request, {
      userId: scope.userId,
      serverDB: scope.serverDB,
    });
    resolvedFactory = () => composition.generationPortFactory!({ ...generationScope, request });
  }
  // A configured ppt-master command without a planner is not a valid
  // generation path. Fail closed instead of silently falling back to the
  // legacy runner, which only emits placeholder SVGs.
  if (composition && !composition.generationPortFactory) {
    return generationErrorResponse(
      Object.assign(new Error('Presentation planner/provider is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      }),
    );
  }
  const result = await handlePresentationRequest(
    request,
    scope,
    matchPresentationRoute(request),
    resolvedFactory,
  );
  if (result.body instanceof Uint8Array) {
    const body = new Uint8Array(result.body.byteLength);
    body.set(result.body);
    return new Response(body.buffer, {
      headers: result.headers,
      status: result.status,
    });
  }
  return NextResponse.json(result.body, {
    headers: result.headers,
    status: result.status,
  });
};

const toGenerationResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  capability: PresentationGenerationCapability | undefined,
  contextFactory: PresentationGenerationContextFactory | undefined,
  scopeFactory: PresentationGenerationScopeFactory,
  eventPublisherFactory: PresentationGenerationEventPublisherFactory | undefined,
  composition: PresentationRuntimeComposition | undefined,
): Promise<Response> => {
  try {
    const resolvedScope = await scopeFactory(request, authenticated);
    if (!resolvedScope || resolvedScope.userId !== authenticated.userId) {
      throw generationScopeError(
        'FORBIDDEN',
        'Generation scope is not bound to the authenticated user',
      );
    }

    if (composition) {
      const result = await composition.generationHandler(request, resolvedScope);
      return NextResponse.json(result.body, {
        headers: result.headers,
        status: result.status,
      });
    }

    // Feed an unavailable seam through the C-57 handler so its method/body/scope
    // validation remains authoritative even when no provider is configured.
    const result = await handlePresentationGenerationRequest(
      request,
      resolvedScope,
      capability ?? unavailableGenerationCapability,
      capability && contextFactory ? contextFactory : unavailableGenerationContextFactory,
      capability && contextFactory && eventPublisherFactory
        ? { generationEventPublisherFactory: eventPublisherFactory }
        : undefined,
    );
    return NextResponse.json(result.body, {
      headers: result.headers,
      status: result.status,
    });
  } catch (error) {
    return generationErrorResponse(error);
  }
};

const toImageGenerationResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  capability: ImageGenerationCapability | undefined,
  composition: PresentationRuntimeComposition | undefined,
  scopeFactory: PresentationGenerationScopeFactory,
): Promise<Response> => {
  try {
    const resolvedScope = await scopeFactory(request, authenticated);
    if (!resolvedScope || resolvedScope.userId !== authenticated.userId) {
      throw generationScopeError(
        'FORBIDDEN',
        'Image generation scope is not bound to the authenticated user',
      );
    }
    const result = await handleImageGenerationRequest(
      request,
      resolvedScope,
      composition?.imageGenerationCapability ?? capability,
    );
    return NextResponse.json(result.body, {
      headers: result.headers,
      status: result.status,
    });
  } catch (error) {
    return generationErrorResponse(error);
  }
};

const toOutlineResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  composition: PresentationRuntimeComposition | undefined,
  scopeFactory: PresentationGenerationScopeFactory,
): Promise<Response> => {
  try {
    const resolvedScope = await scopeFactory(request, authenticated);
    if (!resolvedScope || resolvedScope.userId !== authenticated.userId) {
      throw generationScopeError(
        'FORBIDDEN',
        'Outline scope is not bound to the authenticated user',
      );
    }
    const capability = composition?.outlineCapability;
    if (!capability) {
      throw Object.assign(new Error('Presentation outline provider is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const audience = typeof body.audience === 'string' ? body.audience.trim() : '';
    const style = typeof body.style === 'string' ? body.style.trim() : '';
    const mode = body.mode === 'all' ? 'all' : body.mode === 'slide' ? 'slide' : undefined;
    const slides = Array.isArray(body.allSlides) ? body.allSlides : [];
    if (!topic || !audience || !style || !mode || slides.length === 0) {
      throw Object.assign(new Error('topic, audience, style, mode and allSlides are required'), {
        code: 'PRESENTATION_INVALID',
      });
    }
    const result = await capability.execute(
      {
        brief: { audience, style, topic },
        currentSlides: slides as never,
        operation: 'rewrite',
      },
      { scope: resolvedScope },
    );
    const index = typeof body.index === 'number' ? body.index : Number(body.index);
    return NextResponse.json(
      mode === 'all' ? { slides: result.slides } : { slide: result.slides[index] },
    );
  } catch (error) {
    return generationErrorResponse(error);
  }
};

const toConversationResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  composition: PresentationRuntimeComposition | undefined,
  scopeFactory: PresentationGenerationScopeFactory,
): Promise<Response> => {
  try {
    const resolvedScope = await scopeFactory(request, authenticated);
    if (!resolvedScope || resolvedScope.userId !== authenticated.userId) {
      throw generationScopeError(
        'FORBIDDEN',
        'Conversation scope is not bound to the authenticated user',
      );
    }
    const capability = composition?.conversationCapability;
    if (!capability) {
      throw Object.assign(new Error('Presentation conversation provider is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    if (request.headers.get('content-type')?.startsWith('multipart/form-data'))
      return NextResponse.json(await uploadPresentationAttachment(request, resolvedScope));
    const body = (await request.json()) as Record<string, unknown>;
    const contextRuntime =
      typeof (authenticated.serverDB as LobeChatDatabase)?.select === 'function'
        ? createPresentationContextRuntime(
            createPresentationContextServices(
              authenticated.serverDB as LobeChatDatabase,
              authenticated.userId,
            ),
          )
        : undefined;
    if (
      body.operation === 'turn' &&
      request.headers.get('accept')?.includes('application/x-ndjson')
    ) {
      return conversationStream(
        (onActivity, signal, onCheckpoint) =>
          capability.execute(body as never, {
            scope: resolvedScope,
            tools: contextRuntime,
            capabilities: composition?.atomicRuntime,
            signal,
            onActivity,
            onCheckpoint,
          }),
        async () => {
          await contextRuntime?.dispose();
        },
        request.signal,
      );
    }
    let result;
    try {
      result =
        body.operation === 'catalog'
          ? {
              skills:
                (await contextRuntime?.invoke(
                  'context.listSkills',
                  {},
                  { scope: resolvedScope },
                )) ?? [],
            }
          : await capability.execute(body as never, {
              scope: resolvedScope,
              tools: contextRuntime,
              capabilities: composition?.atomicRuntime,
              signal: request.signal,
            });
    } finally {
      await contextRuntime?.dispose();
    }

    return NextResponse.json(result);
  } catch (error) {
    return generationErrorResponse(error);
  }
};

const toOutlineProposalResponse = async (
  request: Request,
  authenticated: PresentationAuthScope,
  composition: PresentationRuntimeComposition | undefined,
  scopeFactory: PresentationGenerationScopeFactory,
): Promise<Response> => {
  try {
    const resolvedScope = await scopeFactory(request, authenticated);
    if (!resolvedScope || resolvedScope.userId !== authenticated.userId) {
      throw generationScopeError(
        'FORBIDDEN',
        'Outline scope is not bound to the authenticated user',
      );
    }
    const capability = composition?.outlineCapability;
    if (!capability) {
      throw Object.assign(new Error('Presentation outline provider is not configured'), {
        code: 'PROVIDER_UNAVAILABLE',
      });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const result = await capability.execute(body as never, { scope: resolvedScope });
    return NextResponse.json(result);
  } catch (error) {
    return generationErrorResponse(error);
  }
};

const hasExplicitIndividualSeam = (options: PresentationRouteOptions): boolean =>
  options.generationCapability !== undefined ||
  options.imageGenerationCapability !== undefined ||
  options.generationContextFactory !== undefined ||
  options.generationEventPublisherFactory !== undefined ||
  options.jobEventJournal !== undefined ||
  options.jobEventJournalFactory !== undefined ||
  options.portFactory !== undefined ||
  options.scopeCache !== undefined;

export const createPresentationRouteHandler = (
  options: PresentationRouteOptions = {},
): PresentationGuardedHandler => {
  const composition =
    options.composition !== undefined
      ? options.composition
      : !hasExplicitIndividualSeam(options)
        ? configuredDefaultComposition
        : undefined;
  const hasComposition = composition !== undefined;
  const conflictPath = compositionConflictPath(options);
  if (conflictPath) {
    const error = compositionConfigurationError(
      `composition cannot be combined with ${conflictPath}`,
      conflictPath,
    );
    return async () => generationErrorResponse(error);
  }
  if (hasComposition && !isPresentationRuntimeComposition(composition)) {
    const error = compositionConfigurationError(
      'composition must provide generationHandler, journal factories, reset(), and dispose()',
      'composition',
    );
    return async () => generationErrorResponse(error);
  }

  const authenticate = options.authenticate ?? defaultAuthBoundary;
  if (options.scopeCache && options.portFactory) {
    // Contradictory wiring is a programming error: the binding owns the
    // underlying factory; a second one here would silently never run.
    throw new TypeError(
      'Provide either scopeCache or portFactory for the presentation route, not both',
    );
  }
  if (options.jobEventJournal && options.jobEventJournalFactory) {
    throw new TypeError(
      'Provide either jobEventJournal or jobEventJournalFactory for the presentation route, not both',
    );
  }
  const generationScopeFactory = options.generationScopeFactory ?? defaultGenerationScopeFactory;
  const portFactory =
    composition?.portFactory ??
    (options.scopeCache
      ? presentationPortFactoryFromScopeCache(
          options.scopeCache,
          options.sessionIdFor ?? defaultSessionIdFor,
        )
      : (options.portFactory ?? configuredDefaultPortFactory));
  return authenticate((request, scope) =>
    isPresentationJobEventsRequest(request)
      ? toJobEventResponse(request, scope, options, composition, generationScopeFactory)
      : isPresentationReadinessRequest(request)
        ? toReadinessResponse(options)
        : imageGenerationPath(request)
          ? toImageGenerationResponse(
              request,
              scope,
              options.imageGenerationCapability,
              composition,
              generationScopeFactory,
            )
          : outlinePath(request)
            ? new URL(request.url).searchParams.get('mode') === 'propose'
              ? toOutlineProposalResponse(request, scope, composition, generationScopeFactory)
              : toOutlineResponse(request, scope, composition, generationScopeFactory)
            : conversationPath(request)
              ? toConversationResponse(request, scope, composition, generationScopeFactory)
              : generationPath(request)
                ? toGenerationResponse(
                    request,
                    scope,
                    options.generationCapability,
                    options.generationContextFactory,
                    generationScopeFactory,
                    options.generationEventPublisherFactory,
                    composition,
                  )
                : toNextResponse(request, scope, portFactory, composition, generationScopeFactory),
  );
};

const handler = createPresentationRouteHandler();

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
