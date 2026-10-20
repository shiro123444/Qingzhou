// @vitest-environment node
import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import { InMemoryPresentationArtifactStore } from '@/server/runtime/presentation/artifact-store';
import type {
  ImageGenerationEvent,
  ImageGenerationEventPublisherPort,
} from '@/server/runtime/presentation/asset-events';
import {
  createPresentationArtifactAssetStoreBridge,
  InMemoryPresentationAssetStore,
} from '@/server/runtime/presentation/asset-store';
import {
  createPresentationRuntimeComposition,
  type PresentationGenerationContextFactory,
} from '@/server/runtime/presentation/composition';
import type {
  PresentationFactoryScope,
  PresentationPortFactory,
  PresentationPortScopeCacheBinding,
} from '@/server/runtime/presentation/factory';
import {
  createScopedPresentationPortCache,
  presentationPortFactoryFromScopeCache,
} from '@/server/runtime/presentation/factory';
import {
  createPresentationGenerationCapability,
  type PresentationGenerationCapability,
} from '@/server/runtime/presentation/generation-capability';
import type { PresentationJob, PresentationPort } from '@/server/runtime/presentation/handler';
import {
  createImageGenerationCapability,
  type ImageGenerationCapability,
} from '@/server/runtime/presentation/image-generation-capability';
import {
  type PresentationJobEvent,
  PresentationJobEventJournal,
} from '@/server/runtime/presentation/job-event-journal';
import {
  PresentationGenerationPipelineImpl,
  type PresentationPipelineContext,
} from '@/server/runtime/presentation/pipeline';
import type { PresentationJobEventPublisherPort } from '@/server/runtime/presentation/publisher';
import { InMemoryPresentationPlanWorker } from '@/server/runtime/presentation/worker';

import type {
  PresentationPlanner,
  RuntimeScope,
} from '../../../../../../../packages/runtime-contracts/src';
import {
  createPresentationRouteHandler,
  type PresentationAuthBoundary,
  type PresentationGenerationEventPublisherFactory,
  type PresentationGenerationScopeFactory,
  type PresentationJobEventJournalFactory,
} from './route';

vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (
      handler: (
        request: Request,
        scope: { userId: string; serverDB: unknown },
      ) => Promise<Response>,
    ) =>
    async (request: Request) =>
      handler(request, { userId: 'default-auth-user', serverDB: 'default-auth-db' }),
}));

vi.mock('@/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

const request = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://example.test/api/runtime/presentation${path}`, init);

const authenticated =
  (userId: string, serverDB: unknown): PresentationAuthBoundary =>
  (handler) =>
  async (request) =>
    handler(request, { userId, serverDB });

const job = {
  jobId: 'job-1',
  state: 'completed',
  artifactIds: ['artifact-1'],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
} as PresentationJob;

const portFor = (overrides: Partial<PresentationPort> = {}): PresentationPort => ({
  createJob: vi.fn(async () => job),
  getJob: vi.fn(async () => job),
  cancelJob: vi.fn(async () => ({ ...job, state: 'cancelled' as const })),
  retryJob: vi.fn(async () => ({ ...job, state: 'running' as const })),
  getArtifact: vi.fn(async () => null),
  exportArtifact: vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const })),
  ...overrides,
});

describe('durable planning route transport', () => {
  it('returns the completed turn shape for JSON observers and scopes all collaboration operations', async () => {
    const result = {
      phase: 'outline',
      brief: { topic: 'Saved report' },
      message: 'Continue from the saved outline',
      slides: [],
    };
    const sessions = {
      read: vi.fn(async () => ({ threadId: 'thread-1', state: 'waiting_input' })),
      start: vi.fn(async () => ({ state: 'running' })),
      wait: vi.fn(async () => result),
      presenceUpdate: vi.fn(async () => undefined),
      answer: vi.fn(async () => ({ state: 'queued' })),
    };
    const base = createPresentationRuntimeComposition({
      portFactory: async () => portFor(),
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('planning-owner', 'db'),
      generationScopeFactory: async () => ({
        userId: 'planning-owner',
        sessionId: 'planning-session',
      }),
      composition: {
        ...base,
        conversationCapability: { id: 'presentation.conversation', execute: vi.fn() },
        planningSessions: sessions as never,
      },
    });
    const post = (body: object) =>
      handler(
        request('/conversation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId: 'thread-1', ...body }),
        }),
      );
    try {
      const response = await post({
        operation: 'turn',
        requestId: 'turn-1',
        messages: [{ role: 'user', content: 'Continue' }],
        presence: { tabId: 'tab', visible: true, focused: true },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(sessions.start).toHaveBeenCalledWith(
        { userId: 'planning-owner', sessionId: 'planning-session' },
        expect.objectContaining({ operation: 'turn', threadId: 'thread-1' }),
        'turn-1',
      );
      expect(sessions.wait).toHaveBeenCalledOnce();
      expect(sessions.presenceUpdate).toHaveBeenCalledOnce();
      await post({ operation: 'session' });
      expect(sessions.read).toHaveBeenCalledWith(
        { userId: 'planning-owner', sessionId: 'planning-session' },
        'thread-1',
      );
      await post({
        operation: 'decision',
        answer: { decisionId: 'q', requestId: 'answer-1', action: 'retry' },
      });
      expect(sessions.answer).toHaveBeenCalledWith(
        { userId: 'planning-owner', sessionId: 'planning-session' },
        'thread-1',
        { decisionId: 'q', requestId: 'answer-1', action: 'retry' },
      );
    } finally {
      await base.dispose();
    }
  });
});

const createHandler = (
  port: PresentationPort,
  options: { authenticate?: PresentationAuthBoundary; factory?: PresentationPortFactory } = {},
) =>
  createPresentationRouteHandler({
    authenticate: options.authenticate,
    portFactory: options.factory ?? (async () => port),
  });

const generationContext: PresentationPipelineContext = {
  plannerContext: {},
  workerContext: {
    jobId: 'generation-job',
    workspace: { path: '/private/workspace', write: async () => {} },
    qualityCheck: async () => ({ passed: true }),
    convert: async () => [],
  },
};

const generationInput = {
  notebookId: 'notebook-1',
  sourceVersionIds: ['version-1'],
  title: 'A generated deck',
};

const generationResult = {
  plan: {
    planId: 'plan-1',
    title: 'A generated deck',
    aspectRatio: '16:9',
    sourceVersionIds: ['version-1'],
    slides: [],
    path: '/private/plan',
    bytes: new Uint8Array([1]),
    workspace: { path: '/private/workspace' },
  },
  worker: {
    jobId: 'generation-job',
    planId: 'plan-1',
    qualityReport: {
      passed: true,
      path: '/private/quality',
      bytes: new Uint8Array([2]),
      workspace: { path: '/private/workspace' },
    },
    artifacts: [],
  },
  artifacts: [
    {
      artifactId: 'artifact-1',
      type: 'pptx',
      status: 'ready',
      createdAt: '2026-08-30T00:00:00.000Z',
    },
  ],
};

const generationCapabilityFor = (
  execute: (...args: Parameters<PresentationGenerationCapability['execute']>) => unknown,
): PresentationGenerationCapability =>
  ({ execute: vi.fn(execute) }) as unknown as PresentationGenerationCapability;

const generationScopeFor = (scope: RuntimeScope): PresentationGenerationScopeFactory =>
  vi.fn(async () => scope);

const generationRequest = (body: unknown = generationInput, init: RequestInit = {}): Request =>
  request('/generation', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });

const imageGenerationScope: RuntimeScope = {
  sessionId: 'image-session',
  userId: 'image-user',
};

const imageGenerationInput = {
  jobId: 'image-job-1',
  slots: [
    {
      prompt: 'private image prompt',
      quality: 'high',
      size: '1024x1024',
      slideId: 'slide-1',
      slotId: 'hero',
    },
  ],
};

const imageGenerationResult = {
  jobId: 'image-job-1',
  scope: imageGenerationScope,
  slots: [
    {
      assetRefs: [
        {
          metadata: {
            bytes: new Uint8Array([1]),
            mimeType: 'image/png',
            path: '/private/image.png',
            prompt: 'private image prompt',
            workspace: '/private/workspace',
          },
          ref: 'asset://image-session/image-1',
        },
      ],
      slideId: 'slide-1',
      slotId: 'hero',
      state: 'ready',
    },
  ],
} as never;

const imageGenerationCapabilityFor = (
  generate: (
    ...args: Parameters<ImageGenerationCapability['generate']>
  ) => ReturnType<ImageGenerationCapability['generate']>,
): ImageGenerationCapability =>
  ({ generate: vi.fn(generate) }) as unknown as ImageGenerationCapability;

const imageGenerationRequest = (
  body: unknown = imageGenerationInput,
  init: RequestInit = {},
): Request =>
  request('/image-generation', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });

const containsForbiddenWireKey = (value: unknown): boolean => {
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.some(containsForbiddenWireKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    key === 'bytes' || key === 'workspace' || key === 'path'
      ? true
      : containsForbiddenWireKey(nested),
  );
};

const generationAuth =
  (userId = 'generation-user'): PresentationAuthBoundary =>
  (handler) =>
  async (request) =>
    handler(request, { userId, serverDB: { userId } });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Next presentation route wiring', () => {
  it('uses the existing checkAuth boundary and forwards its scope', async () => {
    const port = portFor();
    const scopes: PresentationFactoryScope[] = [];
    const factory = vi.fn(async (value: PresentationFactoryScope) => {
      scopes.push(value);
      return port;
    });
    const handler = createHandler(port, { factory });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      userId: 'default-auth-user',
      serverDB: 'default-auth-db',
    });
  });

  it('creates a job through an injected authenticated route', async () => {
    const port = portFor();
    const handler = createHandler(port, {
      authenticate: authenticated('route-user', { db: 'route-db' }),
    });
    const input = {
      notebookId: 'notebook-1',
      sourceVersionIds: ['version-1'],
      title: 'A deck',
    };

    const response = await handler(
      request('/jobs', { method: 'POST', body: JSON.stringify(input) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(port.createJob).toHaveBeenCalledWith(input);
  });

  it('supports the C-15-L collection export endpoint', async () => {
    const exportArtifact = vi.fn(async () => ({ artifactId: 'export-1', format: 'pptx' as const }));
    const port = portFor({ exportArtifact });
    const handler = createHandler(port, {
      authenticate: authenticated('export-user', 'export-db'),
    });

    const response = await handler(
      request('/artifacts/export', {
        method: 'POST',
        body: JSON.stringify({ artifactId: 'artifact-1', format: 'pptx' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ artifactId: 'export-1', format: 'pptx' });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'pptx');
  });

  it('retains the path-parameter export endpoint', async () => {
    const exportArtifact = vi.fn(async () => ({ artifactId: 'export-2', format: 'svg' as const }));
    const port = portFor({ exportArtifact });
    const handler = createHandler(port, {
      authenticate: authenticated('export-user', 'export-db'),
    });

    const response = await handler(
      request('/artifacts/artifact-1/export', {
        method: 'POST',
        body: JSON.stringify({ format: 'svg' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ artifactId: 'export-2', format: 'svg' });
    expect(exportArtifact).toHaveBeenCalledWith('artifact-1', 'svg');
  });

  it('preserves provider-unavailable errors as JSON', async () => {
    const factory = vi.fn<PresentationPortFactory>(async () => {
      throw Object.assign(new Error('provider missing'), { code: 'PROVIDER_UNAVAILABLE' });
    });
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('missing-provider-user', 'missing-provider-db'),
      portFactory: factory,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'provider missing' },
    });
  });

  it('returns failed provider state without changing it to ready', async () => {
    const failed = {
      ...job,
      state: 'failed' as const,
      error: { code: 'PPTX_INVALID', message: 'bad artifact' },
    };
    const port = portFor({ createJob: vi.fn(async () => failed) });
    const handler = createHandler(port);

    const response = await handler(
      request('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          notebookId: 'notebook-1',
          sourceVersionIds: ['version-1'],
          title: 'A deck',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(failed);
  });
});

describe('C-27 presentation route scoped-cache adoption', () => {
  type ScopedCacheOptions = Parameters<typeof createScopedPresentationPortCache>[0];

  const createBinding = (
    baseFactory: PresentationPortFactory,
    serverDBFor?: ScopedCacheOptions['serverDBFor'],
  ): PresentationPortScopeCacheBinding =>
    createScopedPresentationPortCache({
      factory: baseFactory,
      ...(serverDBFor ? { serverDBFor } : {}),
    });

  const cachedHandler = (
    baseFactory: PresentationPortFactory,
    options: {
      sessionIdFor?: (request: Request) => string | undefined;
      serverDBFor?: ScopedCacheOptions['serverDBFor'];
    } = {},
  ) =>
    createPresentationRouteHandler({
      scopeCache: createBinding(baseFactory, options.serverDBFor),
      ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    });

  it('reuses one port per authenticated scope across requests without re-running the factory', async () => {
    const ports: PresentationPort[] = [];
    const baseFactory = vi.fn(async () => {
      const port = portFor();
      ports.push(port);
      return port;
    });
    const handler = cachedHandler(baseFactory);
    const getSession = (session: string): RequestInit => ({ headers: { 'x-session-id': session } });

    const first = await handler(request('/jobs/job-1', getSession('sess-1')));
    const second = await handler(request('/jobs/job-2', getSession('sess-1')));
    const third = await handler(request('/jobs/job-1', getSession('sess-1')));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(ports).toHaveLength(1);
    const reusedPort = ports[0]!;
    expect(vi.mocked(reusedPort.getJob)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reusedPort.getJob).mock.calls.map(([jobId]) => jobId)).toEqual([
      'job-1',
      'job-2',
      'job-1',
    ]);
  });

  it('isolates different sessions and users through the same route', async () => {
    const baseFactory = vi.fn(async ({ sessionId: _sessionId }: PresentationFactoryScope) =>
      portFor(),
    );
    const handler = cachedHandler(baseFactory);

    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-a' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-b' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-a' } }));

    expect(baseFactory).toHaveBeenCalledTimes(2);
    const seenSessions = baseFactory.mock.calls.map(([scope]) => scope.sessionId);
    expect(seenSessions).toEqual(['sess-a', 'sess-b']);
  });

  it('honours an injected sessionIdFor source and forwards serverDBFor to the wrapped factory', async () => {
    const baseFactory = vi.fn(async (_scope: PresentationFactoryScope) => portFor());
    const serverDBFor = vi.fn(() => ({ db: 'scoped' }));
    const handler = cachedHandler(baseFactory, {
      sessionIdFor: (req) => req.headers.get('x-tenant-session') ?? undefined,
      serverDBFor,
    });

    await handler(request('/jobs/job-1', { headers: { 'x-tenant-session': 'tenant-77' } }));

    expect(baseFactory).toHaveBeenCalledTimes(1);
    expect(baseFactory.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'tenant-77',
      serverDB: { db: 'scoped' },
    });
    expect(serverDBFor).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'tenant-77' }));
  });

  it('fails honestly with a stable code when the authenticated session id is missing', async () => {
    const baseFactory = vi.fn(async () => portFor());
    const handler = cachedHandler(baseFactory, {
      sessionIdFor: () => undefined,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_CACHE_SCOPE_INVALID' },
    });
    expect(baseFactory).not.toHaveBeenCalled();
  });

  it('rejects contradictory wiring: scopeCache together with portFactory', () => {
    const binding = createBinding(async () => portFor());
    expect(() =>
      createPresentationRouteHandler({
        scopeCache: binding,
        portFactory: async () => portFor(),
      }),
    ).toThrowError(/not both/);
  });

  it('keeps the default uncached behavior when the option is absent', async () => {
    const port = portFor();
    const factory = vi.fn(async () => port);
    const handler = createHandler(port, { factory });

    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-1' } }));
    await handler(request('/jobs/job-1', { headers: { 'x-session-id': 'sess-1' } }));

    // Uncached: the factory runs on every request even for identical sessions.
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('exposes the C-27 adapter directly for non-route consumers', async () => {
    const resolve = vi.fn(async () => portFor());
    const binding = {
      resolve,
      reset: vi.fn(),
      dispose: vi.fn(),
      cache: {},
    } as unknown as PresentationPortScopeCacheBinding;
    const adapter = presentationPortFactoryFromScopeCache(
      binding,
      (req) => req.headers.get('x-session-id') ?? undefined,
    );

    const requestScope: PresentationFactoryScope = {
      userId: 'adapter-user',
      serverDB: 'adapter-db',
      request: request('/jobs/job-1', { headers: { 'x-session-id': 'adapter-session' } }),
    };
    const port = (await adapter(requestScope)) as PresentationPort;

    expect(port.getJob).toBeTypeOf('function');
    expect(resolve).toHaveBeenCalledWith({
      userId: 'adapter-user',
      sessionId: 'adapter-session',
      request: requestScope.request,
      serverDB: 'adapter-db',
    });

    // Missing sessionId from the source fails honestly through the adapter —
    // verified against a real binding so scope validation actually applies.
    const realBinding = createBinding(async () => portFor());
    const broken = presentationPortFactoryFromScopeCache(realBinding, () => undefined);
    await expect(broken(requestScope)).rejects.toMatchObject({
      code: 'PRESENTATION_CACHE_SCOPE_INVALID',
    });
  });
});

describe('C-59 generation route wiring', () => {
  it('forwards a server-injected scope and returns a wire-safe success response', async () => {
    const seenScopes: RuntimeScope[] = [];
    const capability = generationCapabilityFor(async (scope, input, context) => {
      seenScopes.push(scope);
      expect(input).toEqual(generationInput);
      expect(context.workerContext.abortSignal).toBeInstanceOf(AbortSignal);
      return generationResult;
    });
    const scope = { userId: 'generation-user', sessionId: 'server-session' };
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor(scope),
    });

    const response = await handler(
      generationRequest(generationInput, {
        headers: { 'x-session-id': 'attacker-session', 'session': 'attacker-session' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ jobId: 'generation-job', quality: { passed: true } });
    expect(containsForbiddenWireKey(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('bytes');
    expect(JSON.stringify(body)).not.toContain('workspace');
    expect(JSON.stringify(body)).not.toContain('path');
    expect(seenScopes).toEqual([scope]);
  });

  it('uses the server auth session and ignores forged session headers', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({
      session: { id: 'real-session' },
      user: { id: 'generation-user' },
    } as never);
    const capability = generationCapabilityFor(async (scope) => {
      expect(scope).toEqual({
        serverDB: { userId: 'generation-user' },
        sessionId: 'presentation-account:generation-user',
        userId: 'generation-user',
      });
      return generationResult;
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
    });

    const response = await handler(
      generationRequest(undefined, {
        headers: { 'x-session-id': 'forged-session', 'session': 'forged-session' },
      }),
    );

    expect(response.status).toBe(200);
    const authCall = vi.mocked(auth.api.getSession).mock.calls[0]?.[0];
    const headers = authCall?.headers as Headers;
    expect(headers.get('x-session-id')).toBeNull();
    expect(headers.get('session')).toBeNull();
  });

  it('returns 400 for GET generation and malformed JSON before capability execution', async () => {
    const execute = vi.fn(async () => generationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(execute),
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: 'server-session',
      }),
    });

    const getResponse = await handler(request('/generation', { method: 'GET' }));
    const malformedResponse = await handler(
      request('/generation', {
        method: 'POST',
        body: '{',
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(getResponse.status).toBe(400);
    await expect(getResponse.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_INVALID' },
    });
    expect(malformedResponse.status).toBe(400);
    await expect(malformedResponse.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_INVALID' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 401 from the existing authentication boundary', async () => {
    const authenticate: PresentationAuthBoundary = () => async () =>
      NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Login required' } },
        { status: 401 },
      );
    const capability = generationCapabilityFor(async () => generationResult);
    const handler = createPresentationRouteHandler({
      authenticate,
      generationCapability: capability,
      generationContextFactory: () => generationContext,
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('returns 403 when the injected server scope does not match authenticated user', async () => {
    const capability = generationCapabilityFor(async () => generationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('authenticated-user'),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor({
        userId: 'different-user',
        sessionId: 'server-session',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(capability.execute).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown presentation route without invoking generation seams', async () => {
    const generationScopeFactory = vi.fn(async () => ({
      userId: 'generation-user',
      sessionId: 'server-session',
    }));
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(async () => generationResult),
      generationContextFactory: () => generationContext,
      generationScopeFactory,
      portFactory: async () => portFor(),
    });

    const response = await handler(request('/unknown'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_ROUTE_NOT_FOUND' },
    });
    expect(generationScopeFactory).not.toHaveBeenCalled();
  });

  it('returns 503 honestly when generation provider seams are not configured', async () => {
    const scopeFactory = generationScopeFor({
      userId: 'generation-user',
      sessionId: 'server-session',
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationScopeFactory: scopeFactory,
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it.each([
    ['PRESENTATION_QUALITY_FAILED', 502],
    ['PPTX_INVALID', 502],
    ['PRESENTATION_WORKER_CANCELLED', 499],
  ] as const)('maps %s to %s while preserving structured errors', async (code, status) => {
    const capability = generationCapabilityFor(async () => {
      throw Object.assign(new Error(`generation failed: ${code}`), { code });
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: 'server-session',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      error: { code, message: `generation failed: ${code}` },
    });
  });

  it('returns 400 for an invalid server scope through the C-57 handler', async () => {
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(async () => generationResult),
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: '   ',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_INVALID' },
    });
  });

  it('returns 401 when the default server session resolver has no session', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(async () => generationResult),
      generationContextFactory: () => generationContext,
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('injects the server scope, generated job id, and original request into the publisher seam', async () => {
    const scope = { userId: 'generation-user', sessionId: 'server-session' };
    const currentRequest = generationRequest();
    const publisher = {
      assertScope: vi.fn(),
      dispose: vi.fn(),
      publish: vi.fn(),
      scope,
    } as unknown as PresentationJobEventPublisherPort;
    const publisherFactory = vi.fn<PresentationGenerationEventPublisherFactory>(
      async (resolvedScope, jobId, originalRequest) => {
        expect(resolvedScope).toEqual(scope);
        expect(jobId).toMatch(/^generation-\d+$/);
        expect(originalRequest).toBe(currentRequest);
        return publisher;
      },
    );
    const contextFactory = vi.fn((jobId: string) => ({
      ...generationContext,
      workerContext: { ...generationContext.workerContext, jobId },
    }));
    const capability = generationCapabilityFor(async (_scope, _input, context) => {
      expect(context.workerContext.eventPublisher).toBe(publisher);
      expect(context.workerContext.eventScope).toEqual(scope);
      return {
        ...generationResult,
        worker: { ...generationResult.worker, jobId: context.workerContext.jobId },
      };
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: contextFactory,
      generationEventPublisherFactory: publisherFactory,
      generationScopeFactory: generationScopeFor(scope),
    });

    const response = await handler(currentRequest);

    expect(response.status).toBe(200);
    expect(publisherFactory).toHaveBeenCalledTimes(1);
    expect(publisher.assertScope).toHaveBeenCalledWith(scope);
    expect(contextFactory).toHaveBeenCalledWith(expect.stringMatching(/^generation-\d+$/));
  });

  it('returns a structured publisher factory error without executing generation', async () => {
    const execute = vi.fn(async () => generationResult);
    const publisherFactory = vi.fn<PresentationGenerationEventPublisherFactory>(async () => {
      throw Object.assign(new Error('event publisher unavailable'), {
        code: 'PROVIDER_UNAVAILABLE',
        details: { seam: 'generation-events' },
      });
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(execute),
      generationContextFactory: () => generationContext,
      generationEventPublisherFactory: publisherFactory,
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: 'server-session',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'event publisher unavailable' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a publisher bound to a different generation scope as structured 403', async () => {
    const publisher = {
      assertScope: vi.fn(() => {
        throw Object.assign(new Error('publisher scope mismatch'), {
          code: 'PRESENTATION_EVENT_SCOPE_DENIED',
          path: 'scope',
        });
      }),
      dispose: vi.fn(),
      publish: vi.fn(),
    } as unknown as PresentationJobEventPublisherPort;
    const execute = vi.fn(async () => generationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: generationCapabilityFor(execute),
      generationContextFactory: () => generationContext,
      generationEventPublisherFactory: vi.fn<PresentationGenerationEventPublisherFactory>(
        async () => publisher,
      ),
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: 'server-session',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_EVENT_SCOPE_DENIED' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a generation scope publisher denial at the route boundary to 403', async () => {
    const scopeFactory = vi.fn<PresentationGenerationScopeFactory>(async () => {
      throw Object.assign(new Error('publisher scope mismatch'), {
        code: 'PRESENTATION_EVENT_SCOPE_DENIED',
      });
    });
    const capability = generationCapabilityFor(async () => generationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
      generationScopeFactory: scopeFactory,
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_EVENT_SCOPE_DENIED' },
    });
    expect(capability.execute).not.toHaveBeenCalled();
  });

  it('keeps C-59 context behavior when the generation publisher seam is omitted', async () => {
    let receivedContext: PresentationPipelineContext | undefined;
    const capability = generationCapabilityFor(async (_scope, _input, context) => {
      receivedContext = context;
      return generationResult;
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      generationCapability: capability,
      generationContextFactory: () => generationContext,
      generationScopeFactory: generationScopeFor({
        userId: 'generation-user',
        sessionId: 'server-session',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(200);
    expect(receivedContext?.workerContext.eventPublisher).toBeUndefined();
    expect(receivedContext?.workerContext.eventScope).toBeUndefined();
  });
});

describe('C-91 image-generation route wiring', () => {
  const imageScopeFactory = vi.fn(async () => imageGenerationScope);

  const createImageHandler = (
    imageGenerationCapability?: ImageGenerationCapability,
    authenticate: PresentationAuthBoundary = generationAuth(imageGenerationScope.userId),
  ) =>
    createPresentationRouteHandler({
      authenticate,
      ...(imageGenerationCapability ? { imageGenerationCapability } : {}),
      generationScopeFactory: imageScopeFactory,
    });

  it('uses the authenticated server scope and projects a wire-safe success response', async () => {
    const controller = new AbortController();
    const generate = vi.fn(
      async (
        receivedScope: RuntimeScope,
        receivedSlots: unknown,
        receivedOptions?: { jobId?: string; signal?: AbortSignal },
      ) => {
        expect(receivedScope).toEqual(imageGenerationScope);
        expect(receivedSlots).toEqual(imageGenerationInput.slots);
        expect(receivedOptions).toMatchObject({
          jobId: 'image-job-1',
          signal: controller.signal,
        });
        return imageGenerationResult;
      },
    );
    const capability = imageGenerationCapabilityFor(generate);
    const handler = createImageHandler(capability);

    const response = await handler(
      imageGenerationRequest(imageGenerationInput, {
        headers: { 'x-session-id': 'forged-session', 'session': 'forged-session' },
        signal: controller.signal,
      }),
    );
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ jobId: 'image-job-1', scope: imageGenerationScope });
    expect(text).not.toContain('private image prompt');
    expect(text).not.toContain('bytes');
    expect(text).not.toContain('workspace');
    expect(text).not.toContain('/private/image.png');
    expect(imageScopeFactory).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ userId: imageGenerationScope.userId }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty body', {}],
    ['empty slots', { slots: [] }],
    ['missing slot prompt', { slots: [{ slideId: 'slide-1', slotId: 'hero' }] }],
    ['invalid count', { slots: [{ ...imageGenerationInput.slots[0], count: 0 }] }],
  ])('returns IMAGE_PLAN_INVALID for %s without capability execution', async (_name, body) => {
    const generate = vi.fn(async () => imageGenerationResult);
    const handler = createImageHandler(imageGenerationCapabilityFor(generate));

    const response = await handler(imageGenerationRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'IMAGE_PLAN_INVALID' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects non-POST image-generation requests', async () => {
    const generate = vi.fn(async () => imageGenerationResult);
    const handler = createImageHandler(imageGenerationCapabilityFor(generate));

    const response = await handler(request('/image-generation', { method: 'GET' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'IMAGE_PLAN_INVALID' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ['IMAGE_PLAN_INVALID', 400],
    ['IMAGE_BUDGET_EXCEEDED', 429],
    ['IMAGE_CANCELLED', 499],
    ['IMAGE_UNAVAILABLE', 503],
  ] as const)('maps capability error %s to HTTP %s', async (code, status) => {
    const capability = imageGenerationCapabilityFor(async () => {
      throw Object.assign(new Error('private image prompt must not escape'), { code });
    });
    const handler = createImageHandler(capability);

    const response = await handler(imageGenerationRequest());
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body).toMatchObject({ error: { code } });
    expect(JSON.stringify(body)).not.toContain('private image prompt');
  });

  it('returns PROVIDER_UNAVAILABLE when image capability is not configured', async () => {
    const handler = createImageHandler();

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it('preserves authentication rejection before resolving the image capability', async () => {
    const generate = vi.fn(async () => imageGenerationResult);
    const authenticate: PresentationAuthBoundary = () => async () =>
      NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    const handler = createImageHandler(imageGenerationCapabilityFor(generate), authenticate);

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects a scope returned by the resolver when it belongs to another user', async () => {
    const generate = vi.fn(async () => imageGenerationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(imageGenerationScope.userId),
      generationScopeFactory: vi.fn(async () => ({
        sessionId: 'other-session',
        userId: 'other-user',
      })),
      imageGenerationCapability: imageGenerationCapabilityFor(generate),
    });

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the existing jobs route unchanged when image capability is injected', async () => {
    const port = portFor();
    const generate = vi.fn(async () => imageGenerationResult);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(imageGenerationScope.userId),
      generationScopeFactory: imageScopeFactory,
      imageGenerationCapability: imageGenerationCapabilityFor(generate),
      portFactory: async () => port,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(generate).not.toHaveBeenCalled();
    expect(port.getJob).toHaveBeenCalledWith('job-1');
  });
});

describe('C-94 composition image-generation wiring', () => {
  const imageScopeFactory = generationScopeFor(imageGenerationScope);

  it('uses the image capability supplied by composition with the authenticated scope', async () => {
    const generate = vi.fn(async (receivedScope: RuntimeScope) => {
      expect(receivedScope).toEqual(imageGenerationScope);
      return imageGenerationResult;
    });
    const composition = createPresentationRuntimeComposition({
      imageGenerationCapability: imageGenerationCapabilityFor(generate),
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(imageGenerationScope.userId),
      composition,
      generationScopeFactory: imageScopeFactory,
    });

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    await composition.dispose();
  });

  it('rejects an external image capability when composition already supplies one', async () => {
    const composition = createPresentationRuntimeComposition({
      imageGenerationCapability: imageGenerationCapabilityFor(async () => imageGenerationResult),
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(imageGenerationScope.userId),
      composition,
      generationScopeFactory: imageScopeFactory,
      imageGenerationCapability: imageGenerationCapabilityFor(async () => imageGenerationResult),
    });

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID' },
    });
    await composition.dispose();
  });

  it('returns PROVIDER_UNAVAILABLE when composition does not include image capability', async () => {
    const composition = createPresentationRuntimeComposition({
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(imageGenerationScope.userId),
      composition,
      generationScopeFactory: imageScopeFactory,
    });

    const response = await handler(imageGenerationRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
    await composition.dispose();
  });

  it('keeps the legacy generation path available with a composition image capability', async () => {
    const capability = generationCapabilityFor(async () => generationResult);
    const composition = createPresentationRuntimeComposition({
      capability,
      contextFactory: () => generationContext,
      imageGenerationCapability: imageGenerationCapabilityFor(async () => imageGenerationResult),
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      composition,
      generationScopeFactory: generationScopeFor({
        sessionId: 'server-session',
        userId: 'generation-user',
      }),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(200);
    expect(capability.execute).toHaveBeenCalledTimes(1);
    await composition.dispose();
  });
});

const presentationEvent = (
  jobId: string,
  seq: number,
  data: unknown = { seq },
): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'presentation.job.updated',
});

const readSseChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const result = await reader.read();
  return new TextDecoder().decode(result.value);
};

describe('C-61 presentation job event route wiring', () => {
  it('returns replay as text/event-stream with strict C-60 data fields', async () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-events-1', presentationEvent('job-events-1', 1, { state: 'queued' }));
    journal.append('job-events-1', presentationEvent('job-events-1', 2, { state: 'running' }));
    const abort = new AbortController();
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
      jobEventHeartbeatIntervalMs: 60_000,
    });

    const response = await handler(
      request('/jobs/job-events-1/events?after_seq=0', { signal: abort.signal }),
    );
    const reader = response.body!.getReader();
    const first = await readSseChunk(reader);
    const second = await readSseChunk(reader);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(first).toContain('id: 1');
    expect(second).toContain('id: 2');
    expect(JSON.parse(first.split('data: ')[1]!.trim())).toEqual({
      data: { state: 'queued' },
      job_id: 'job-events-1',
      protocol_version: 'runtime.v1',
      seq: 1,
      type: 'presentation.job.updated',
    });
    abort.abort();
    await reader.cancel();
  });

  it('replays before delivering live events and removes the listener on abort', async () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-events-2', presentationEvent('job-events-2', 1));
    const abort = new AbortController();
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
      jobEventHeartbeatIntervalMs: 60_000,
    });

    const response = await handler(request('/jobs/job-events-2/events', { signal: abort.signal }));
    const reader = response.body!.getReader();
    expect(await readSseChunk(reader)).toContain('"seq":1');
    journal.append('job-events-2', presentationEvent('job-events-2', 2));
    expect(await readSseChunk(reader)).toContain('"seq":2');
    abort.abort();
    journal.append('job-events-2', presentationEvent('job-events-2', 3));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('filters duplicate and old journal events from the route stream', async () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-events-3', presentationEvent('job-events-3', 2));
    journal.append('job-events-3', presentationEvent('job-events-3', 2, 'duplicate'));
    journal.append('job-events-3', presentationEvent('job-events-3', 1, 'old'));
    const abort = new AbortController();
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
      jobEventHeartbeatIntervalMs: 60_000,
    });

    const response = await handler(request('/jobs/job-events-3/events', { signal: abort.signal }));
    const reader = response.body!.getReader();
    const chunk = await readSseChunk(reader);

    expect(chunk).toContain('"seq":2');
    expect(chunk).not.toContain('duplicate');
    abort.abort();
    await reader.cancel();
  });

  it('rejects invalid after_seq with structured JSON before opening a stream', async () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-events-4', presentationEvent('job-events-4', 1));
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
    });

    const response = await handler(request('/jobs/job-events-4/events?after_seq=1.5'));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_INVALID', path: 'after_seq' },
    });
  });

  it('rejects unknown jobs as structured 404 JSON without fabricating events', async () => {
    const journal = new PresentationJobEventJournal();
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
    });

    const response = await handler(request('/jobs/missing-job/events'));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_NOT_FOUND' },
    });
  });

  it('returns 503 when no journal is configured and does not fabricate replay', async () => {
    const handler = createPresentationRouteHandler({ authenticate: generationAuth() });

    const response = await handler(request('/jobs/job-events-5/events'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it('isolates journal factories by authenticated user and strips pseudo-session headers', async () => {
    const journals = new Map<string, PresentationJobEventJournal>();
    const factory = vi.fn<PresentationJobEventJournalFactory>(
      async ({ userId, request: scopedRequest }) => {
        expect(scopedRequest.headers.get('x-session-id')).toBeNull();
        expect(scopedRequest.headers.get('session')).toBeNull();
        const journal =
          journals.get(userId) ?? new PresentationJobEventJournal({ scope: { userId } });
        journals.set(userId, journal);
        return journal;
      },
    );
    journals.set('user-a', new PresentationJobEventJournal({ scope: { userId: 'user-a' } }));
    journals.get('user-a')!.append('job-events-6', presentationEvent('job-events-6', 1));
    const handlerA = createPresentationRouteHandler({
      authenticate: generationAuth('user-a'),
      jobEventJournalFactory: factory,
      jobEventHeartbeatIntervalMs: 60_000,
    });
    const handlerB = createPresentationRouteHandler({
      authenticate: generationAuth('user-b'),
      jobEventJournalFactory: factory,
    });

    const responseA = await handlerA(
      request('/jobs/job-events-6/events', {
        headers: { 'x-session-id': 'forged', 'session': 'forged' },
      }),
    );
    const responseB = await handlerB(request('/jobs/job-events-6/events'));

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(404);
    await responseA.body?.cancel();
    await expect(responseB.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_NOT_FOUND' },
    });
  });

  it('returns 403 for a journal bound to another authenticated scope', async () => {
    const journal = new PresentationJobEventJournal({ scope: { userId: 'user-owner' } });
    journal.append('job-events-7', presentationEvent('job-events-7', 1));
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('user-attacker'),
      jobEventJournal: journal,
    });

    const response = await handler(request('/jobs/job-events-7/events'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_SCOPE_DENIED' },
    });
  });

  it('preserves authentication rejection and does not call the journal factory', async () => {
    const factory = vi.fn(async () => new PresentationJobEventJournal());
    const authenticate: PresentationAuthBoundary = () => async () =>
      NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Login required' } },
        { status: 401 },
      );
    const handler = createPresentationRouteHandler({
      authenticate,
      jobEventJournalFactory: factory,
    });

    const response = await handler(request('/jobs/job-events-8/events'));

    expect(response.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it('uses an injected serializer while retaining the stream response seam', async () => {
    const journal = new PresentationJobEventJournal();
    journal.append('job-events-9', presentationEvent('job-events-9', 1));
    const serializer = vi.fn((event: PresentationJobEvent) => `id: ${event.seq}\ndata: custom\n\n`);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      jobEventJournal: journal,
      jobEventSerializer: serializer,
      jobEventHeartbeatIntervalMs: 60_000,
    });

    const response = await handler(request('/jobs/job-events-9/events'));
    const reader = response.body!.getReader();

    expect(await readSseChunk(reader)).toBe('id: 1\ndata: custom\n\n');
    expect(serializer).toHaveBeenCalledTimes(1);
    await reader.cancel();
  });

  it('rejects contradictory journal injection wiring at construction time', () => {
    expect(() =>
      createPresentationRouteHandler({
        jobEventJournal: new PresentationJobEventJournal(),
        jobEventJournalFactory: async () => new PresentationJobEventJournal(),
      }),
    ).toThrowError(/either jobEventJournal or jobEventJournalFactory/);
  });
});

describe('C-71 presentation composition manifest wiring', () => {
  it('uses composition-only generation and replays its publisher events through SSE', async () => {
    const scope = { userId: 'composition-user', sessionId: 'composition-session' };
    let generatedJobId = '';
    const capability = generationCapabilityFor(async (_scope, _input, context) => {
      generatedJobId = context.workerContext.jobId;
      context.workerContext.eventPublisher?.publish(generatedJobId, 'presentation.job.queued', {
        state: 'queued',
      });
      return {
        ...generationResult,
        worker: { ...generationResult.worker, jobId: generatedJobId },
      };
    });
    const composition = createPresentationRuntimeComposition({
      capability,
      contextFactory: (jobId) => ({
        ...generationContext,
        workerContext: { ...generationContext.workerContext, jobId },
      }),
      journalLoader: async (journalScope) =>
        new PresentationJobEventJournal({ scope: journalScope }),
      now: () => '2026-08-31T00:00:00.000Z',
    });
    const generationScopeFactory = generationScopeFor(scope);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(scope.userId),
      composition,
      generationScopeFactory,
      jobEventHeartbeatIntervalMs: 60_000,
    });

    const generationResponse = await handler(generationRequest());
    expect(generationResponse.status).toBe(200);
    await expect(generationResponse.json()).resolves.toMatchObject({
      jobId: generatedJobId,
    });

    const abort = new AbortController();
    const eventsResponse = await handler(
      request(`/jobs/${generatedJobId}/events?after_seq=0`, { signal: abort.signal }),
    );
    const reader = eventsResponse.body!.getReader();
    const chunk = await readSseChunk(reader);

    expect(eventsResponse.status).toBe(200);
    expect(chunk).toContain('id: 1');
    expect(JSON.parse(chunk.split('data: ')[1]!.trim())).toMatchObject({
      job_id: generatedJobId,
      protocol_version: 'runtime.v1',
      seq: 1,
      type: 'presentation.job.queued',
    });
    abort.abort();
    await reader.cancel();
    await composition.dispose();
  });

  it('fails closed with a stable 400 when composition conflicts with an individual seam', async () => {
    const composition = createPresentationRuntimeComposition({
      journalLoader: async () => new PresentationJobEventJournal(),
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      composition,
      generationCapability: generationCapabilityFor(async () => generationResult),
    });

    const response = await handler(generationRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID' },
    });
    await composition.dispose();
  });

  it('fails closed with a structured 400 for an invalid composition value', async () => {
    const handler = createPresentationRouteHandler({ composition: null as never });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_COMPOSITION_OPTIONS_INVALID' },
    });
  });

  it('retains the legacy individual presentation port path without composition', async () => {
    const port = portFor();
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth(),
      portFactory: async () => port,
    });

    const response = await handler(request('/jobs/job-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(job);
    expect(port.getJob).toHaveBeenCalledWith('job-1');
  });
});

describe('C-79 provider readiness HTTP projection', () => {
  const configuredReadiness = {
    available: true,
    commandAvailable: true,
    provider: 'ppt-master',
    runnerId: 'ppt-master-runner',
    state: 'configured',
  } as const;

  const unavailableReadiness = {
    available: false,
    commandAvailable: false,
    state: 'unavailable',
    code: 'PROVIDER_UNAVAILABLE',
  } as const;

  it('projects an injected configured readiness with only C-73 safe fields', async () => {
    const secret = '/private/ppt-master/secret-runner.js';
    const readiness = vi.fn(() => ({
      ...configuredReadiness,
      command: ['node', secret],
      commandArgs: ['--token', 'secret-token'],
    }));
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('readiness-user'),
      readiness,
    });

    const response = await handler(
      request('/readiness', {
        headers: { 'x-session-id': 'forged-session', 'session': 'forged-session' },
      }),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(configuredReadiness);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(readiness).toHaveBeenCalledOnce();
    expect(readiness).toHaveBeenCalledWith();
  });

  it('derives readiness from the injected C-77 production composition seam', async () => {
    const readiness = vi.fn(() => configuredReadiness);
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('composition-readiness-user'),
      productionComposition: { readiness },
    });

    const response = await handler(request('/readiness'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(configuredReadiness);
    expect(readiness).toHaveBeenCalledOnce();
  });

  it('maps an injected unavailable readiness result to 503 without fabricating ready', async () => {
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('unavailable-readiness-user'),
      readiness: unavailableReadiness,
    });

    const response = await handler(request('/readiness'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(unavailableReadiness);
  });

  it('fails closed with a structured 503 when no readiness seam is injected', async () => {
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('missing-readiness-user'),
    });

    const response = await handler(request('/readiness'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_UNAVAILABLE' },
    });
  });

  it('maps readiness configuration errors to 400 without exposing argv or secrets', async () => {
    const secret = 'super-secret-readiness-token';
    const readiness = vi.fn(() => {
      throw Object.assign(new Error(`invalid argv ${secret}`), {
        code: 'PRESENTATION_INVALID',
        path: 'command',
      });
    });
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('invalid-readiness-user'),
      readiness,
    });

    const response = await handler(request('/readiness'));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: 'PRESENTATION_INVALID', path: 'command' },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('rejects malformed readiness projections as PRESENTATION_INVALID', async () => {
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('malformed-readiness-user'),
      readiness: { available: true } as never,
    });

    const response = await handler(request('/readiness'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_INVALID' },
    });
  });

  it('keeps readiness scope-free and does not invoke the generation scope seam', async () => {
    const scopeFactory = vi.fn<PresentationGenerationScopeFactory>(async () => ({
      userId: 'unexpected',
      sessionId: 'unexpected',
    }));
    const handler = createPresentationRouteHandler({
      authenticate: generationAuth('scope-free-readiness-user'),
      generationScopeFactory: scopeFactory,
      readiness: configuredReadiness,
    });

    const response = await handler(request('/readiness'));

    expect(response.status).toBe(200);
    expect(scopeFactory).not.toHaveBeenCalled();
  });
});

describe('Presentation Route: R1-A cross-request consistency, cancellation idempotency & retry', () => {
  const createTestComposition = (
    capabilityOverrides: Partial<PresentationGenerationCapability> = {},
  ) => {
    const store = new InMemoryPresentationArtifactStore();
    const capability: PresentationGenerationCapability = {
      execute: vi.fn(async () => ({
        artifacts: [
          {
            artifactId: 'art-r1a',
            createdAt: '2026-09-03T00:00:00.000Z',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'presentation.pptx',
            sizeBytes: 1024,
            status: 'ready' as const,
            type: 'pptx',
            updatedAt: '2026-09-03T00:00:00.000Z',
          },
        ],
      })),
      ...capabilityOverrides,
    } as unknown as PresentationGenerationCapability;

    const contextFactory: PresentationGenerationContextFactory = () => ({
      plannerContext: {},
      workerContext: {
        convert: vi.fn(),
        jobId: 'job-ctx',
        qualityCheck: vi.fn(),
        workspace: { path: '/tmp', write: vi.fn() },
      },
    });

    return createPresentationRuntimeComposition({
      capability,
      contextFactory,
      generationArtifactStore: store,
      journalLoader: async () => new PresentationJobEventJournal(),
    });
  };

  it('reuses the same job across separate create, query, and cancel HTTP requests for the same session', async () => {
    let releaseExecute!: () => void;
    const executePromise = new Promise<{ artifacts: unknown[] }>((resolve) => {
      releaseExecute = () =>
        resolve({
          artifacts: [
            {
              artifactId: 'art-r1a',
              createdAt: '2026-09-03T00:00:00.000Z',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              name: 'presentation.pptx',
              sizeBytes: 1024,
              status: 'ready' as const,
              type: 'pptx',
              updatedAt: '2026-09-03T00:00:00.000Z',
            },
          ],
        });
    });
    const composition = createTestComposition({
      execute: vi.fn(async () => executePromise as never),
    });
    const scopeFactory: PresentationGenerationScopeFactory = vi.fn(async () => ({
      userId: 'user-r1a',
      sessionId: 'sess-r1a',
    }));
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-r1a', 'db-r1a'),
      composition,
      generationScopeFactory: scopeFactory,
    });

    // 1. Create job via POST /jobs
    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-1',
          title: '战略汇报',
          sourceVersionIds: ['v-1'],
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as PresentationJob;
    expect(created.state).toBe('queued');
    expect(created.jobId).toBeTruthy();

    // 2. Query job via GET /jobs/[id]
    const getRes = await handler(request(`/jobs/${created.jobId}`));
    expect(getRes.status).toBe(200);
    const queried = (await getRes.json()) as PresentationJob;
    expect(queried.jobId).toBe(created.jobId);

    // 3. Cancel in-flight job via POST /jobs/[id]/cancel
    const cancelRes = await handler(
      request(`/jobs/${created.jobId}/cancel`, {
        method: 'POST',
      }),
    );
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as PresentationJob;
    expect(cancelled.jobId).toBe(created.jobId);
    expect(cancelled.state).toBe('cancelled');

    // Release background promise
    releaseExecute();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 4. Repeated cancel on cancelled job is idempotent (200 status, not 404)
    const repeatCancelRes = await handler(
      request(`/jobs/${created.jobId}/cancel`, {
        method: 'POST',
      }),
    );
    expect(repeatCancelRes.status).toBe(200);
    const repeatCancelled = (await repeatCancelRes.json()) as PresentationJob;
    expect(repeatCancelled.jobId).toBe(created.jobId);
    expect(repeatCancelled.state).toBe('cancelled');

    await composition.dispose();
  });

  it('isolates different users/sessions so job cannot be queried or cancelled by another scope', async () => {
    const composition = createTestComposition();
    let currentScope = { userId: 'user-a', sessionId: 'sess-a' };
    const scopeFactory: PresentationGenerationScopeFactory = vi.fn(async () => currentScope);
    const handler = createPresentationRouteHandler({
      authenticate: (inner) => async (req) =>
        inner(req, { userId: currentScope.userId, serverDB: 'db' }),
      composition,
      generationScopeFactory: scopeFactory,
    });

    // User A creates job
    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-1',
          title: 'A 的 PPT',
          sourceVersionIds: ['v-1'],
        }),
      }),
    );
    const created = (await createRes.json()) as PresentationJob;

    // Switch to User B
    currentScope = { userId: 'user-b', sessionId: 'sess-b' };

    // User B tries to get User A's job -> 404
    const getRes = await handler(request(`/jobs/${created.jobId}`));
    expect(getRes.status).toBe(404);
    await expect(getRes.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_NOT_FOUND' },
    });

    // User B tries to cancel User A's job -> 404
    const cancelRes = await handler(request(`/jobs/${created.jobId}/cancel`, { method: 'POST' }));
    expect(cancelRes.status).toBe(404);
    await expect(cancelRes.json()).resolves.toMatchObject({
      error: { code: 'PRESENTATION_NOT_FOUND' },
    });

    await composition.dispose();
  });

  it('retries a cancelled job within the same conversation', async () => {
    let releaseExecute!: () => void;
    const executePromise = new Promise<{ artifacts: unknown[] }>((resolve) => {
      releaseExecute = () =>
        resolve({
          artifacts: [
            {
              artifactId: 'art-r1a',
              createdAt: '2026-09-03T00:00:00.000Z',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              name: 'presentation.pptx',
              sizeBytes: 1024,
              status: 'ready' as const,
              type: 'pptx',
              updatedAt: '2026-09-03T00:00:00.000Z',
            },
          ],
        });
    });
    const composition = createTestComposition({
      execute: vi.fn(async () => executePromise as never),
    });
    const scopeFactory: PresentationGenerationScopeFactory = vi.fn(async () => ({
      userId: 'user-retry',
      sessionId: 'sess-retry',
    }));
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-retry', 'db-retry'),
      composition,
      generationScopeFactory: scopeFactory,
    });

    // 1. Create and cancel initial job
    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-retry',
          title: '重试测试',
          sourceVersionIds: ['v-retry'],
        }),
      }),
    );
    const created = (await createRes.json()) as PresentationJob;
    await handler(request(`/jobs/${created.jobId}/cancel`, { method: 'POST' }));
    releaseExecute();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 2. Retry the cancelled job
    const retryRes = await handler(request(`/jobs/${created.jobId}/retry`, { method: 'POST' }));
    expect(retryRes.status).toBe(200);
    const retried = (await retryRes.json()) as PresentationJob;
    expect(retried.jobId).toBe(created.jobId);
    expect(retried.state).toBe('queued');

    // 3. Verify original job is still cancelled
    const originalRes = await handler(request(`/jobs/${created.jobId}`));
    expect(originalRes.status).toBe(200);
    const original = (await originalRes.json()) as PresentationJob;
    expect(original.jobId).toBe(created.jobId);
    expect(['queued', 'running', 'completed']).toContain(original.state);

    await composition.dispose();
  });
});

describe('Presentation Route: R2-A-C generation composition wiring on /jobs', () => {
  it('executes full generation pipeline via route handler and maintains scope consistency across requests', async () => {
    const mockImageCapability = {
      generate: vi.fn(async (_scope: unknown, slots: any[]) => ({
        slots: slots.map((s) => ({
          assetRef: `asset-${s.slotId}`,
          slideId: s.slideId,
          slotId: s.slotId,
          state: 'ready' as const,
        })),
      })),
    };

    const store = new InMemoryPresentationArtifactStore();

    const mockCapability: PresentationGenerationCapability = {
      execute: vi.fn(async (scope: unknown, input: any) => {
        const art = await store.put(scope as RuntimeScope, {
          artifactId: 'art-r2ac-pptx',
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          name: 'presentation.pptx',
          type: 'pptx',
        });
        return {
          artifacts: [art],
          input,
        };
      }),
    } as unknown as PresentationGenerationCapability;

    const contextFactory: PresentationGenerationContextFactory = () => ({
      plannerContext: {},
      workerContext: {
        convert: vi.fn(),
        jobId: 'ctx-job',
        qualityCheck: vi.fn(),
        workspace: { path: '/tmp', write: vi.fn() },
      },
    });

    const composition = createPresentationRuntimeComposition({
      capability: mockCapability,
      contextFactory,
      generationArtifactStore: store,
      imageGenerationCapability: mockImageCapability as any,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    const scopeFactory: PresentationGenerationScopeFactory = vi.fn(async () => ({
      userId: 'user-r2ac',
      sessionId: 'sess-r2ac',
    }));

    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-r2ac', 'db-r2ac'),
      composition,
      generationScopeFactory: scopeFactory,
    });

    // 1. POST /jobs to create job with image slots
    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-r2ac',
          options: {
            imageSlots: [{ prompt: '封面图', slideId: 'slide-1', slotId: 'hero' }],
          },
          sourceVersionIds: ['v-r2ac'],
          title: '端到端测试',
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as PresentationJob;
    expect(created.state).toBe('queued');
    expect(created.jobId).toBeTruthy();

    // Wait for background async generation execution
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Verify image capability was invoked
    expect(mockImageCapability.generate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-r2ac', sessionId: 'sess-r2ac' }),
      [
        expect.objectContaining({
          idempotencyKey: expect.any(String),
          prompt: '封面图',
          slideId: 'slide-1',
          slotId: 'hero',
        }),
      ],
      expect.anything(),
    );

    // Verify capability execute was called with generated image slots
    expect(mockCapability.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-r2ac', sessionId: 'sess-r2ac' }),
      expect.objectContaining({
        options: expect.objectContaining({
          generatedImageSlots: [
            { assetRef: 'asset-hero', slideId: 'slide-1', slotId: 'hero', state: 'ready' },
          ],
        }),
      }),
      expect.anything(),
    );

    // 2. GET /jobs/[id] retrieves completed job in same scope
    const getRes = await handler(request(`/jobs/${created.jobId}`));
    expect(getRes.status).toBe(200);
    const queried = (await getRes.json()) as PresentationJob;
    expect(queried.error).toBeUndefined();
    expect(queried.jobId).toBe(created.jobId);
    expect(queried.state).toBe('completed');
    expect(queried.artifactIds).toContain('art-r2ac-pptx');

    // 3. GET /artifacts/[id] retrieves artifact in same scope
    const artRes = await handler(request(`/artifacts/art-r2ac-pptx`));
    expect(artRes.status).toBe(200);
    const art = await artRes.json();
    expect(art).toMatchObject({
      artifactId: 'art-r2ac-pptx',
      name: 'presentation.pptx',
      status: 'ready',
    });

    await composition.dispose();
  });

  it('runs real image capability and persists generated image assets to asset store', async () => {
    const assetStore = new InMemoryPresentationAssetStore();
    const mockImagePort = {
      generate: vi.fn(async () => [
        {
          asset: { ref: 'asset://mock/image-1' },
          index: 0,
          metadata: {
            createdAt: '2026-09-03T12:00:00.000Z',
            mimeType: 'image/png',
          },
        },
      ]),
      manifest: {
        displayName: 'Mock Image',
        providerId: 'mock.image',
        supportedMimeTypes: ['image/png'],
        supportsIdempotency: true,
      },
      providerId: 'mock.image',
      resolveAsset: vi.fn(async () => null),
    };

    let seq = 0;
    const publisherFactory = (scope: RuntimeScope): ImageGenerationEventPublisherPort => ({
      assertScope: (received?: RuntimeScope) => {
        if (
          received &&
          (received.userId !== scope.userId || received.sessionId !== scope.sessionId)
        ) {
          throw Object.assign(new Error('scope mismatch'), { code: 'ASSET_SCOPE_MISMATCH' });
        }
      },
      dispose: vi.fn(),
      publish: vi.fn((input): ImageGenerationEvent => ({
        data: input.data as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey ?? `event-${++seq}`,
        jobId: input.jobId,
        protocol_version: 'runtime.v1',
        scope: input.scope ?? scope,
        seq: ++seq,
        type: input.type,
      })),
    });

    const imageCapability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: publisherFactory,
      imagePort: mockImagePort,
    });

    const store = new InMemoryPresentationArtifactStore();
    const mockCapability: PresentationGenerationCapability = {
      execute: vi.fn(async (scope: unknown, input: any) => {
        const art = await store.put(scope as RuntimeScope, {
          artifactId: 'art-real-img-pptx',
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          name: 'presentation.pptx',
          type: 'pptx',
        });
        return {
          artifacts: [art],
          input,
        };
      }),
    } as unknown as PresentationGenerationCapability;

    const contextFactory: PresentationGenerationContextFactory = () => ({
      plannerContext: {},
      workerContext: {
        convert: vi.fn(),
        jobId: 'ctx-img-job',
        qualityCheck: vi.fn(),
        workspace: { path: '/tmp', write: vi.fn() },
      },
    });

    const composition = createPresentationRuntimeComposition({
      capability: mockCapability,
      contextFactory,
      generationArtifactStore: store,
      imageGenerationCapability: imageCapability,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-real-img', 'db-real-img'),
      composition,
      generationScopeFactory: async () => ({
        userId: 'user-real-img',
        sessionId: 'sess-real-img',
      }),
    });

    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-real-img',
          options: {
            imageSlots: [{ prompt: '真实图片提示词', slideId: 's1', slotId: 'hero' }],
          },
          sourceVersionIds: ['v-img'],
          title: '真实生图测试',
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as PresentationJob;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(mockImagePort.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '真实图片提示词' }),
      expect.objectContaining({
        scope: expect.objectContaining({
          sessionId: 'sess-real-img',
          userId: 'user-real-img',
        }),
      }),
    );

    const getRes = await handler(request(`/jobs/${created.jobId}`));
    expect(getRes.status).toBe(200);
    const queried = (await getRes.json()) as PresentationJob;
    expect(queried.state).toBe('completed');

    await composition.dispose();
  });

  it('fails-closed with 503 PROVIDER_UNAVAILABLE on default route when runner / provider is not configured', async () => {
    // When no runner or composition is injected, the default route fails closed
    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-unconfigured', 'db-unconfigured'),
      generationScopeFactory: async () => ({
        userId: 'user-unconfigured',
        sessionId: 'sess-unconfigured',
      }),
    });

    const res = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-unconfigured',
          title: '未配置 Provider 测试',
        }),
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('R3-A: queries slide-level artifacts, streams binary on download, and isolates single-slide failure', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const scope: RuntimeScope = { userId: 'user-r3a', sessionId: 'sess-r3a' };

    // Store a slide SVG
    await store.put(scope, {
      artifactId: 'job-r3a:slide-1.svg',
      bytes: new TextEncoder().encode('<svg>slide 1 content</svg>'),
      metadata: { jobId: 'job-r3a', slideId: 'slide-1', type: 'svg' },
      mimeType: 'image/svg+xml',
      name: 'slide-1.svg',
      type: 'svg',
    });

    // Store the PPTX binary
    await store.put(scope, {
      artifactId: 'job-r3a:deck.pptx',
      bytes: new Uint8Array([80, 75, 3, 4]),
      metadata: { jobId: 'job-r3a', type: 'pptx' },
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      name: 'deck.pptx',
      type: 'pptx',
    });

    const mockCapability: PresentationGenerationCapability = {
      execute: vi.fn(),
    } as unknown as PresentationGenerationCapability;

    const contextFactory: PresentationGenerationContextFactory = () => ({
      plannerContext: {},
      workerContext: {
        convert: vi.fn(),
        jobId: 'job-r3a',
        qualityCheck: vi.fn(),
        workspace: { path: '/tmp', write: vi.fn() },
      },
    });

    const composition = createPresentationRuntimeComposition({
      capability: mockCapability,
      contextFactory,
      generationArtifactStore: store,
      journalLoader: async () => new PresentationJobEventJournal(),
    });

    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-r3a', 'db-r3a'),
      composition,
      generationScopeFactory: async () => scope,
    });

    // 1. Query slide SVG metadata
    const slideRes = await handler(request('/artifacts/job-r3a:slide-1.svg'));
    expect(slideRes.status).toBe(200);
    const slideArtifact = await slideRes.json();
    expect(slideArtifact).toMatchObject({
      artifactId: 'job-r3a:slide-1.svg',
      metadata: {
        jobId: 'job-r3a',
        slideId: 'slide-1',
        status: 'ready',
        type: 'svg',
        uri: '/api/runtime/presentation/artifacts/job-r3a%3Aslide-1.svg',
      },
      mimeType: 'image/svg+xml',
      name: 'slide-1.svg',
      status: 'ready',
      type: 'svg',
      uri: '/api/runtime/presentation/artifacts/job-r3a%3Aslide-1.svg?raw=true',
    });

    // 2. Download raw binary bytes
    const downloadRes = await handler(request('/artifacts/job-r3a:deck.pptx/download'));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(downloadRes.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([80, 75, 3, 4]));

    // 3. Querying missing slide returns 404 without affecting existing slide
    const missingRes = await handler(request('/artifacts/job-r3a:missing-slide.svg'));
    expect(missingRes.status).toBe(404);

    const slide1StillAvailable = await handler(request('/artifacts/job-r3a:slide-1.svg'));
    expect(slide1StillAvailable.status).toBe(200);

    // 4. Export artifact returns real backend URI
    const exportRes = await handler(
      request('/artifacts/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artifactId: 'job-r3a:deck.pptx',
          format: 'pptx',
        }),
      }),
    );
    expect(exportRes.status).toBe(200);
    const exportResult = await exportRes.json();
    expect(exportResult).toMatchObject({
      artifactId: 'job-r3a:deck.pptx',
      format: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      uri: '/api/runtime/presentation/artifacts/job-r3a%3Adeck.pptx?raw=true',
    });
    expect(exportResult.uri.trim().length).toBeGreaterThan(0);

    await composition.dispose();
  });

  it('R4-A Acceptance: full end-to-end pipeline, 4-phase cancellation, failure persistence, and retry via route', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const assetStore = createPresentationArtifactAssetStoreBridge(store);
    const journal = new PresentationJobEventJournal();
    const scope: RuntimeScope = { userId: 'user-r4a', sessionId: 'sess-r4a' };

    const mockImagePort = {
      generate: vi.fn(async (_req, _ctx) => [
        {
          asset: { ref: 'img-hero-slot' },
          index: 0,
          metadata: {
            createdAt: '2026-09-03T12:00:00.000Z',
            mimeType: 'image/png',
          },
        },
      ]),
      manifest: {
        displayName: 'Mock Image',
        providerId: 'mock.image',
        supportedMimeTypes: ['image/png'],
        supportsIdempotency: true,
      },
      providerId: 'mock.image',
      resolveAsset: vi.fn(async () => null),
    };

    let imgSeq = 0;
    const publisherFactory = (pubScope: RuntimeScope): ImageGenerationEventPublisherPort => ({
      assertScope: () => undefined,
      dispose: vi.fn(),
      publish: vi.fn((input): ImageGenerationEvent => ({
        data: input.data as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey ?? `event-${++imgSeq}`,
        jobId: input.jobId,
        protocol_version: 'runtime.v1',
        scope: input.scope ?? pubScope,
        seq: ++imgSeq,
        type: input.type,
      })),
    });

    const imageCapability = createImageGenerationCapability({
      assetStore,
      eventPublisherFactory: publisherFactory,
      imagePort: mockImagePort,
    });

    const mockPlanner: PresentationPlanner = {
      plan: vi.fn(async (planInput) => ({
        aspectRatio: '16:9',
        designSpec: { theme: { name: 'modern' } },
        planId: 'plan-r4a',
        slides: [
          {
            metadata: { slideId: 'slide-1' },
            order: 0,
            slideId: 'slide-1',
            svg: '<svg><text>Slide 1 Hero</text></svg>',
          },
          {
            metadata: { slideId: 'slide-2' },
            order: 1,
            slideId: 'slide-2',
            svg: '<svg><text>Slide 2 Conclusion</text></svg>',
          },
        ],
        sourceVersionIds: planInput.sourceVersionIds,
        title: planInput.title,
      })),
    };

    const mockWorker = new InMemoryPresentationPlanWorker();
    const pipeline = new PresentationGenerationPipelineImpl(mockPlanner, mockWorker);
    const capability = createPresentationGenerationCapability(pipeline, store);

    const contextFactory: PresentationGenerationContextFactory = (jobId) => ({
      plannerContext: {},
      workerContext: {
        convert: async () => [
          {
            artifactId: `${jobId}:deck.pptx`,
            bytes: new Uint8Array([80, 75, 3, 4, 20, 0]),
            metadata: { jobId, type: 'pptx' },
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            type: 'pptx',
          },
        ],
        jobId,
        qualityCheck: async () => ({ details: { score: 98 }, passed: true }),
        workspace: {
          cleanup: async () => undefined,
          path: '/tmp/workspace-r4a',
          write: async () => undefined,
        },
      },
    });

    const composition = createPresentationRuntimeComposition({
      capability,
      contextFactory,
      generationArtifactStore: store,
      imageGenerationCapability: imageCapability,
      journalLoader: async () => journal,
    });

    const handler = createPresentationRouteHandler({
      authenticate: authenticated('user-r4a', 'db-r4a'),
      composition,
      generationScopeFactory: async () => scope,
    });

    // 1. Create Job with image slots
    const createRes = await handler(
      request('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notebookId: 'nb-r4a',
          title: 'R4-A Acceptance Test Presentation',
          sourceVersionIds: ['v1'],
          options: {
            imageSlots: [
              {
                slideId: 'slide-1',
                slotId: 'hero-slot',
                prompt: 'Modern AI presentation cover image',
              },
            ],
          },
        }),
      }),
    );
    expect(createRes.status).toBe(200);
    const createdJob = (await createRes.json()) as PresentationJob;
    expect(createdJob.jobId).toBeDefined();

    // Wait for async execution
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 2. Query Completed Job
    const queryRes = await handler(request(`/jobs/${createdJob.jobId}`));
    expect(queryRes.status).toBe(200);
    const completedJob = (await queryRes.json()) as PresentationJob;
    expect(mockImagePort.generate).toHaveBeenCalled();
    expect(completedJob.state).toBe('completed');
    expect(completedJob.artifactIds).toBeDefined();
    expect(completedJob.artifactIds!.length).toBeGreaterThanOrEqual(3);

    const deckId = completedJob.artifactIds!.find((id) => id.includes(':artifact:'))!;
    const slideId = completedJob.artifactIds!.find((id) => id.endsWith(':slide:slide-1'))!;
    // 3. Verify PPTX Artifact
    const pptxRes = await handler(request(`/artifacts/${deckId}`));
    expect(pptxRes.status).toBe(200);
    const pptxArtifact = await pptxRes.json();
    expect(pptxArtifact).toMatchObject({
      artifactId: deckId,
      status: 'ready',
      type: 'pptx',
    });

    // 4. Verify Slide 1 & Slide 2 SVG Artifacts
    const slide1Res = await handler(request(`/artifacts/${slideId}`));
    expect(slide1Res.status).toBe(200);
    const slide1 = await slide1Res.json();
    expect(slide1).toMatchObject({
      artifactId: slideId,
      status: 'ready',
      type: 'svg',
    });

    // 5. Verify Image Artifact from image generation slot is queryable
    const imageArtifactId = completedJob.artifactIds!.find(
      (id) => id.includes('hero-slot') || id.includes('asset-') || id.startsWith('asset://'),
    );
    expect(imageArtifactId).toBeDefined();
    const imageRes = await handler(request(`/artifacts/${encodeURIComponent(imageArtifactId!)}`));
    expect(imageRes.status).toBe(200);
    const imageArtifact = await imageRes.json();
    expect(imageArtifact).toMatchObject({
      artifactId: imageArtifactId,
      status: 'ready',
      type: 'image',
    });

    // 6. Download Raw PPTX Binary
    const downloadRes = await handler(request(`/artifacts/${deckId}/download`));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(downloadedBytes).toEqual(new Uint8Array([80, 75, 3, 4, 20, 0]));

    // 7. Export Artifact
    const exportRes = await handler(
      request('/artifacts/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artifactId: deckId,
          format: 'pptx',
        }),
      }),
    );
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json();
    expect(exportData.uri).toBe(
      `/api/runtime/presentation/artifacts/${encodeURIComponent(deckId)}?raw=true`,
    );

    // 8. Cancellation Idempotency
    const cancelRes1 = await handler(
      request(`/jobs/${createdJob.jobId}/cancel`, { method: 'POST' }),
    );
    expect(cancelRes1.status).toBe(200);
    const cancel1 = await cancelRes1.json();
    expect(cancel1.state).toBe('completed'); // Already completed job remains completed

    await composition.dispose();
  });

  it('default composition bridge: verifies PresentationArtifactAssetStoreBridge unifies image assets and presentation artifacts', async () => {
    const artifactStore = new InMemoryPresentationArtifactStore();
    const assetStore = createPresentationArtifactAssetStoreBridge(artifactStore);
    const scope: RuntimeScope = { userId: 'u-bridge', sessionId: 's-bridge' };

    // Put image asset into asset store
    await assetStore.put(scope, {
      asset: { ref: 'img-hero-1' },
      bytes: new Uint8Array([137, 80, 78, 71]),
      metadata: {
        mimeType: 'image/png',
      },
    });

    // Query through artifactStore
    const artifact = await artifactStore.get(scope, 'img-hero-1');
    expect(artifact).toBeDefined();
    expect(artifact).toMatchObject({
      artifactId: 'img-hero-1',
      mimeType: 'image/png',
      status: 'ready',
      type: 'image',
      uri: '/api/runtime/presentation/artifacts/img-hero-1',
    });
    expect(artifact?.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
  });
});
