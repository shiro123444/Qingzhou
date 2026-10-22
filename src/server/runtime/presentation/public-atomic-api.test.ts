import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PresentationJob,
  PresentationPlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import { atomicPlanner, atomicWorker, createPresentationAtomicRuntime } from './atomic-plugin';
import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { handlePresentationRequest, matchPresentationRoute } from './handler';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { PresentationGenerationPipelineImpl } from './pipeline';
import { FileTeachingMemory, TeachingLearning } from './teaching-memory';
import { FilePresentationTemplateLibrary } from './templates/library';
import { FileTrialLearningStore } from './trial-learning';
import { FileTrialEvidenceStore, PresentationTrialReview } from './trial-review';
import { PresentationTrialValidation } from './trial-validation';
import { PresentationTrialWorkspace } from './trial-workspace';
import { InMemoryPresentationPlanWorker } from './worker';

const owner: RuntimeScope = { sessionId: 'owner-session', userId: 'owner' };
const svg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="100">${text}</text></svg>`;
const source: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'source-plan',
  slides: [
    { order: 1, slideId: 'cover', svg: svg('Preserve cover') },
    { notes: 'Original notes', order: 2, slideId: 'detail', svg: svg('Original detail') },
    { order: 3, slideId: 'closing', svg: svg('Preserve closing') },
  ],
  sourceVersionIds: [],
  title: 'Public tools',
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const createHarness = async () => {
  const root = await mkdtemp(join(tmpdir(), 'presentation-public-tools-'));
  const storage = new FilePresentationStorage(root);
  const planner = { plan: vi.fn(async () => structuredClone(source)) };
  const teaching = new TeachingLearning(
    new FileTeachingMemory(join(root, 'memory')),
    new FilePresentationTemplateLibrary({ root: join(root, 'templates') }),
    {} as MultimodalChatPort,
  );
  const evidence = new FileTrialEvidenceStore(join(root, 'evidence'));
  const learning = new FileTrialLearningStore({ root: join(root, 'learning'), evidence, storage });
  const workspace = new PresentationTrialWorkspace({
    companion: new PresentationTrialValidation({
      root: join(root, 'validation'),
      workerRoot: join(root, 'trial-tasks'),
      storage,
      evidence,
      learning,
      createSession: async () => {
        throw new Error('No paid validation in HTTP seam tests');
      },
    }),
    learning,
    root: join(root, 'trial-tasks'),
    storage,
    evidence: new FileTrialEvidenceStore(join(root, 'evidence')),
    createRunner: async () => ({
      runner: {
        drain: async () => {},
        run: async () => ({
          schemaVersion: 1,
          runId: randomUUID(),
          status: 'budget-exceeded',
          originalRetained: true,
          selectedId: 'baseline',
          calls: [],
          charged: { tokens: 0, costMicros: 0 },
          variants: [],
        }),
      },
      dispose: async () => {},
    }),
  });
  const runtime = createPresentationAtomicRuntime({
    teachingLearning: teaching,
    operations: [
      ...new PresentationTrialReview(
        new FileTrialEvidenceStore(join(root, 'evidence')),
        storage,
      ).operations(),
      ...workspace.operations(),
      ...learning.operations(),
    ],
    artifactStore: storage,
    planner,
    worker: new InMemoryPresentationPlanWorker(),
  });
  const pipeline = new PresentationGenerationPipelineImpl(
    atomicPlanner(runtime),
    atomicWorker(runtime),
  );
  const ports = new Map<string, PresentationGenerationPort>();
  const portFor = (scope: RuntimeScope) => {
    const key = JSON.stringify([scope.userId, scope.sessionId]);
    let port = ports.get(key);
    if (!port) {
      port = new PresentationGenerationPort(
        {
          artifactStore: storage,
          atomicRuntime: runtime,
          capability: new PresentationGenerationCapability(pipeline, storage),
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: async () => [
                {
                  bytes: new Uint8Array([80, 75, 3, 4]),
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  name: 'deck.pptx',
                  type: 'pptx',
                },
              ],
              jobId: 'placeholder',
              qualityCheck: async () => ({ passed: true }),
              workspace: { path: root, write: async () => {} },
            },
          }),
          idFactory: () => 'owned-job',
          repository: storage,
        },
        { ...scope, request: new Request('http://localhost') },
      );
      ports.set(key, port);
    }
    return port;
  };
  cleanups.push(async () => {
    await Promise.all([...ports.values()].map((port) => port.dispose()));
    await workspace.drain();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (operation: string | undefined, input?: unknown, scope = owner) => {
    const path = operation ? `/tools/${encodeURIComponent(operation)}` : '/tools';
    const request = new Request(
      `http://localhost/api/runtime/presentation${path}`,
      operation
        ? {
            body: JSON.stringify(input),
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }
        : undefined,
    );
    return handlePresentationRequest(
      request,
      { ...scope, serverDB: undefined },
      matchPresentationRoute(request),
      async (authenticated) =>
        portFor({ sessionId: authenticated.sessionId!, userId: authenticated.userId }),
    );
  };
  const terminal = async (): Promise<PresentationJob> => {
    await vi.waitFor(
      async () =>
        expect(['completed', 'failed', 'cancelled']).toContain(
          (await portFor(owner).getJob('owned-job'))?.state,
        ),
      { interval: 10, timeout: 5000 },
    );
    return (await portFor(owner).getJob('owned-job'))!;
  };
  await portFor(owner).createJob({
    notebookId: 'studio',
    slideCount: 3,
    sourceVersionIds: [],
    title: 'Public tools',
  });
  const initial = await terminal();
  expect(initial).toMatchObject({ state: 'completed', versionId: expect.any(String) });
  return { call, initial, learning, planner, port: portFor(owner), runtime, terminal, workspace };
};

describe('public presentation atomic tools', () => {
  it('routes held-out operations through the public allowlist with strict inputs and no promotion operation', async () => {
    const h = await createHarness();
    const validationId = `validation-${'a'.repeat(64)}`;
    expect(await h.call('presentation.validation.status', { validationId })).toMatchObject({
      status: 404,
      body: { error: { code: 'PRESENTATION_NOT_FOUND' } },
    });
    expect(
      (
        await h.call('presentation.validation.start', {
          validationId,
          confirmed: true,
          maxTokens: 999999,
        })
      ).status,
    ).toBe(400);
    expect((await h.call('presentation.validation.promote', { validationId })).status).toBe(404);
    const catalog = await h.runtime.catalog();
    expect(
      catalog
        .filter((entry) => entry.name.startsWith('presentation.validation.'))
        .every((entry) => entry.agent === undefined),
    ).toBe(true);
  });
  it('runs explicit start/status/cancel through native Cordis with authenticated ownership and strict policy', async () => {
    const h = await createHarness();
    const input = {
      jobId: 'owned-job',
      expectedVersionId: h.initial.versionId,
      slideId: 'detail',
      requestId: randomUUID(),
      confirmed: true,
    };
    expect((await h.call('presentation.trial.start', { ...input, maxTokens: 999999 })).status).toBe(
      400,
    );
    expect((await h.call('presentation.trial.start', { ...input, confirmed: false })).status).toBe(
      400,
    );
    const started = await h.call('presentation.trial.start', input);
    expect(started.status).toBe(200);
    const body = started.body as { execution: { executionId: string } };
    await h.workspace.drain();
    expect(
      (await h.call('presentation.trial.status', { jobId: 'owned-job', slideId: 'detail' })).body,
    ).toMatchObject({ execution: { state: 'budget-exceeded' } });
    expect(
      (await h.call('presentation.trial.cancel', { executionId: body.execution.executionId }))
        .status,
    ).toBe(200);
    expect(
      (
        await h.call(
          'presentation.trial.cancel',
          { executionId: body.execution.executionId },
          { userId: 'other', sessionId: 'owner-session' },
        )
      ).status,
    ).toBe(404);
    expect(h.workspace.operations().every((op) => op.agent === undefined)).toBe(true);
  });

  it('reads pending experience through owned native operations and rejects promotion fields', async () => {
    const h = await createHarness();
    await h.call('presentation.trial.start', {
      jobId: 'owned-job',
      expectedVersionId: h.initial.versionId,
      slideId: 'detail',
      requestId: randomUUID(),
      confirmed: true,
    });
    await h.workspace.drain();
    const list = await h.call('presentation.learning.list', {
      jobId: 'owned-job',
      slideId: 'detail',
    });
    expect(list.status).toBe(200);
    const { episodes } = list.body as { episodes: { episodeId: string }[] };
    expect(episodes).toHaveLength(1);
    const protocol = await h.learning.readProtocol(owner, episodes[0].episodeId);
    expect(protocol?.episode).toMatchObject({
      schemaVersion: 2,
      id: episodes[0].episodeId,
      domain: 'presentation',
      validation: 'pending',
      applicability: 'source-page-only',
    });
    expect(protocol?.configurations.map((revision) => revision.id)).toEqual(
      protocol?.episode.configurationRefs,
    );
    const read = await h.call('presentation.learning.read', { episodeId: episodes[0].episodeId });
    expect(read).toMatchObject({
      status: 200,
      body: { status: 'pending-validation', kind: 'attempt' },
    });
    expect(
      (
        await h.call(
          'presentation.learning.read',
          { episodeId: episodes[0].episodeId },
          { userId: 'other', sessionId: 'owner-session' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await h.call('presentation.learning.read', {
          episodeId: episodes[0].episodeId,
          status: 'active',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call('presentation.learning.promote', { episodeId: episodes[0].episodeId })).status,
    ).toBe(404);
  });
  it('dispatches owned trial review operations through the authenticated public allowlist', async () => {
    const { call } = await createHarness();
    expect(
      await call('presentation.trial.list', { jobId: 'owned-job', slideId: 'detail' }),
    ).toMatchObject({ status: 200, body: { trials: [] } });
    expect(
      (
        await call(
          'presentation.trial.list',
          { jobId: 'owned-job', slideId: 'detail' },
          { userId: 'other', sessionId: 'owner-session' },
        )
      ).status,
    ).toBe(404);
    expect((await call('presentation.trial.read', { runId: 'missing' })).status).toBe(404);
  });

  it('exposes teaching retrieval/composition but never an approval tool', async () => {
    const { call, runtime } = await createHarness();
    const catalog = JSON.stringify((await call(undefined)).body);
    expect(catalog).toContain('presentation.teaching.analyze');
    expect(catalog).toContain('presentation.teaching.search');
    expect(catalog).toContain('presentation.teaching.compose');
    expect(catalog).not.toContain('presentation.teaching.review');
    expect((await call('presentation.teaching.search', { query: '教学' })).status).toBe(200);
    expect((await call('presentation.teaching.compose', { ids: [] })).status).toBe(200);
    expect(
      (await runtime.snapshot(owner)).operations
        .filter(({ state }) => state === 'completed')
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['teaching.memory.search', 'teaching.memory.compose']));
    expect((await call('presentation.teaching.review', { action: 'confirm' })).status).not.toBe(
      200,
    );
  });
  it('exposes lesson compilation and does not certify a non-teaching deck as a lesson', async () => {
    const { call } = await createHarness();
    const catalog = await call(undefined);
    expect(JSON.stringify(catalog.body)).toContain('presentation.lesson.compile');
    const compiled = await call('presentation.lesson.compile', {
      input: { notebookId: 'n', title: 'Ordinary', sourceVersionIds: [] },
    });
    expect(compiled.status).toBe(200);
    expect(JSON.stringify(compiled.body)).toContain('Ordinary');
    const validated = await call('presentation.lesson.validate', { plan: source });
    expect(validated.status).not.toBe(200);
  });
  it('exposes formula measurement and composes its measured bounds into vector rendering', async () => {
    const { call } = await createHarness();
    const measured = await call('presentation.formula.measure', { latex: 'x^2', fontSize: 28 });
    expect(measured.status).toBe(200);
    // Public dispatch must preserve the measurement payload, not only list a tool name.
    expect(JSON.stringify(measured.body)).toContain('minRectWidth');
  });
  it('exposes scientific diagram geometry as a Cordis measurement capability', async () => {
    const { call } = await createHarness();
    const result = await call('presentation.diagram.measure', {
      width: 420,
      block: {
        id: 'visual-1',
        kind: 'scientific-diagram',
        title: '方法比较',
        rect: { x: 0, y: 0, width: 420, height: 180 },
        provenance: { kind: 'illustrative' },
        spec: {
          type: 'plot',
          xRange: [0, 1],
          yRange: [0, 1],
          xLabel: 'x',
          yLabel: 'y',
          series: ['GD', 'SGD', 'Adam', 'AdamW'].map((label) => ({
            label,
            points: [
              [0, 0],
              [1, 1],
            ],
          })),
        },
      },
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain('224');
  });
  it('exposes discoverable public schemas, dispatches owned page reads and rejects internal execution tools', async () => {
    const { call, initial } = await createHarness();
    const catalog = await call(undefined);
    expect(catalog.status).toBe(200);
    const { tools } = catalog.body as {
      tools: { inputSchema: Record<string, unknown>; name: string }[];
    };
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'presentation.job.read',
        'presentation.page.read',
        'presentation.page.replace',
        'presentation.job.message',
        'presentation.job.export',
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toContain('presentation.render');
    expect(tools.map((tool) => tool.name)).not.toContain('presentation.slide.replace');
    expect(
      tools.find((tool) => tool.name === 'presentation.page.replace')?.inputSchema,
    ).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ expectedVersionId: { type: 'string', minLength: 1 } }),
    });

    const read = await call('presentation.page.read', { jobId: 'owned-job', page: 2 });
    expect(read).toMatchObject({
      status: 200,
      body: { slide: source.slides[1], versionId: initial.versionId },
    });
    expect(
      await call('presentation.render', {
        plan: source,
        services: { workerContext: '/untrusted/path' },
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await call('presentation.slide.replace', {
        plan: source,
        slideId: 'detail',
        svg: svg('Bypass'),
      }),
    ).toMatchObject({ status: 404 });
  });

  it('commits an exact single-page patch, retains other pages, and replays the same request without a new version', async () => {
    const { call, initial, planner, port, terminal } = await createHarness();
    const patch = {
      expectedVersionId: initial.versionId,
      jobId: 'owned-job',
      notes: 'Updated notes',
      page: 2,
      requestId: 'patch-1',
      svg: svg('Exact replacement'),
    };
    expect(
      await call('presentation.page.replace', { ...patch, expectedVersionId: 'stale-version' }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRESENTATION_CONFLICT' } } });
    expect((await port.getJob('owned-job'))?.revisions).toHaveLength(1);
    expect(await call('presentation.page.replace', patch)).toMatchObject({ status: 200 });
    const completed = await terminal();
    expect(completed).toMatchObject({
      state: 'completed',
      messages: [{ requestId: 'patch-1', status: 'applied' }],
    });
    expect(completed.versionId).not.toBe(initial.versionId);
    const current = await port.readPlan('owned-job');
    expect(current.plan.slides[0]).toEqual(source.slides[0]);
    expect(current.plan.slides[2]).toEqual(source.slides[2]);
    expect(current.plan.slides[1]).toEqual({
      ...source.slides[1],
      notes: patch.notes,
      svg: patch.svg,
    });
    expect(planner.plan).toHaveBeenCalledTimes(1);

    const repeated = await call('presentation.page.replace', patch);
    expect(repeated).toMatchObject({
      status: 200,
      body: { versionId: completed.versionId, state: 'completed' },
    });
    expect((await port.getJob('owned-job'))?.revisions).toHaveLength(2);
    expect(
      await call('presentation.page.replace', {
        ...patch,
        requestId: 'stale-second-write',
        svg: svg('Stale overwrite'),
      }),
    ).toMatchObject({ status: 409 });
    expect(
      await call('presentation.page.replace', {
        ...patch,
        expectedVersionId: completed.versionId,
        svg: svg('Request-id conflict'),
      }),
    ).toMatchObject({ status: 400 });
  });

  it('admits only one concurrent exact edit against the same base version', async () => {
    const { call, initial, port, terminal } = await createHarness();
    const patch = { expectedVersionId: initial.versionId, jobId: 'owned-job', page: 2 };
    const responses = await Promise.all([
      call('presentation.page.replace', {
        ...patch,
        requestId: 'first-editor',
        svg: svg('First edit'),
      }),
      call('presentation.page.replace', {
        ...patch,
        requestId: 'second-editor',
        svg: svg('Second edit'),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await terminal()).toMatchObject({ state: 'completed' });
    expect((await port.getJob('owned-job'))?.messages).toHaveLength(1);
    expect((await port.getJob('owned-job'))?.revisions).toHaveLength(2);
  });

  it('keeps job data scoped by user and session and rejects trusted-context fields in public arguments', async () => {
    const { call, initial, port } = await createHarness();
    for (const scope of [
      { ...owner, sessionId: 'other-session' },
      { ...owner, userId: 'other-user' },
    ]) {
      expect(await call('presentation.job.read', { jobId: 'owned-job' }, scope)).toMatchObject({
        status: 404,
      });
      expect(
        await call(
          'presentation.page.replace',
          {
            expectedVersionId: initial.versionId,
            jobId: 'owned-job',
            page: 2,
            requestId: 'other-owner',
            svg: svg('Cross-scope write'),
          },
          scope,
        ),
      ).toMatchObject({ status: 404 });
    }
    expect(
      await call('presentation.page.read', {
        jobId: 'owned-job',
        page: 2,
        scope: { userId: 'owner', sessionId: 'owner-session' },
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call('presentation.page.read', {
        jobId: 'owned-job',
        page: 2,
        services: { port: { userId: 'owner' } },
      }),
    ).toMatchObject({ status: 400 });
    expect((await port.getJob('owned-job'))?.revisions).toHaveLength(1);
    expect((await port.readPlan('owned-job')).plan.slides.map((slide) => slide.svg)).toEqual(
      source.slides.map((slide) => slide.svg),
    );
  });
});
