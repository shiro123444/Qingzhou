import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import type { ImageGenerationCapability } from './image-generation-capability';
import { presentationStoryboardInputFingerprint } from './visual-storyboard';

const scope = { request: new Request('https://example.test'), userId: 'u1', sessionId: 's1' };
const input = { notebookId: 'n1', title: '演示', sourceVersionIds: ['v1'] };

describe('PresentationGenerationPort', () => {
  it('returns queued immediately and completes through the generation capability', async () => {
    const store = new InMemoryPresentationArtifactStore(() => '2026-01-01T00:00:00.000Z');
    const capability = {
      execute: vi.fn(async () => ({
        artifacts: [
          {
            artifactId: 'a1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            sizeBytes: 3,
            status: 'ready' as const,
            type: 'pptx',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-1',
      },
      scope,
    );

    const queued = await port.createJob(input);
    expect(queued).toMatchObject({ jobId: 'job-1', state: 'queued' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(port.getJob('job-1')).resolves.toMatchObject({
      state: 'completed',
      artifactIds: ['a1'],
    });
    expect(capability.execute).toHaveBeenCalledWith(
      scope,
      input,
      expect.objectContaining({ plannerContext: expect.objectContaining({ scope }) }),
    );
  });

  it('accepts prompt-only presentations when no source versions are attached', async () => {
    const capability = {
      execute: vi.fn(async () => ({ artifacts: [] })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-prompt-only',
      },
      scope,
    );

    await expect(
      port.createJob({ notebookId: 'studio', sourceVersionIds: [], title: '仅提示词演示' }),
    ).resolves.toMatchObject({ jobId: 'job-prompt-only', state: 'queued' });
  });

  it('aborts and permanently removes a job together with its owned artifacts', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const removeJob = vi.fn().mockResolvedValue(undefined);
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability: {
          execute: vi.fn(async () => ({ artifacts: [] })),
        } as unknown as PresentationGenerationCapability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-delete',
        repository: {
          getJob: vi.fn(async () => null),
          removeJob,
          saveJob: vi.fn(async () => undefined),
        },
      },
      scope,
    );
    await port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.put(scope, {
      artifactId: 'artifact-delete',
      metadata: { jobId: 'job-delete' },
      mimeType: 'image/svg+xml',
      name: 'slide.svg',
      type: 'svg',
    });

    await port.deleteJob('job-delete');

    expect(removeJob).toHaveBeenCalledWith(scope, 'job-delete');
    await expect(store.get(scope, 'artifact-delete')).resolves.toBeNull();
    await expect(port.getJob('job-delete')).resolves.toBeNull();
  });

  it('runs requested image slots before planning so assets can be referenced by the planner', async () => {
    const imageGenerationCapability = {
      generate: vi.fn(async () => ({ slots: [{ slotId: 'hero', state: 'ready' }] })),
    } as unknown as ImageGenerationCapability;
    const capability = {
      execute: vi.fn(async (_scope: unknown, receivedInput: typeof input) => ({
        artifacts: [],
        input: receivedInput,
      })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-images',
        imageGenerationCapability,
      },
      scope,
    );
    await port.createJob({
      ...input,
      options: { imageSlots: [{ slideId: 's1', slotId: 'hero', prompt: '封面' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(imageGenerationCapability.generate).toHaveBeenCalledWith(
      scope,
      [
        expect.objectContaining({
          idempotencyKey: 'job-images:s1:hero',
          prompt: '封面',
          slideId: 's1',
          slotId: 'hero',
        }),
      ],
      expect.objectContaining({ jobId: 'job-images' }),
    );
    expect(capability.execute).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        options: expect.objectContaining({
          generatedImageSlots: [{ slotId: 'hero', state: 'ready' }],
        }),
      }),
      expect.anything(),
    );
  });

  it('cancels an in-flight generation without fabricating an artifact', async () => {
    let release!: () => void;
    const capability = {
      execute: vi.fn(
        () =>
          new Promise<never>((_, reject) => {
            release = () =>
              reject(
                Object.assign(new Error('cancelled'), { code: 'PRESENTATION_WORKER_CANCELLED' }),
              );
          }),
      ),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-cancel',
      },
      scope,
    );
    await port.createJob(input);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const cancelled = await port.cancelJob('job-cancel');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled.state).toBe('cancelled');
    await expect(port.getJob('job-cancel')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('handles cancellation idempotently across repeated cancels and terminal states', async () => {
    let idSeq = 0;
    const store = new InMemoryPresentationArtifactStore();
    const capability = {
      execute: vi.fn(async () => ({
        artifacts: [
          {
            artifactId: 'art-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            name: 'deck.pptx',
            sizeBytes: 10,
            status: 'ready' as const,
            type: 'pptx',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })),
    } as never;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => `job-${++idSeq}`,
      },
      scope,
    );

    // 1. Unknown job throws PRESENTATION_NOT_FOUND
    await expect(port.cancelJob('non-existent')).rejects.toMatchObject({
      code: 'PRESENTATION_NOT_FOUND',
    });

    // 2. Cancel in queued/running state
    const job1 = await port.createJob(input);
    const cancel1 = await port.cancelJob(job1.jobId);
    expect(cancel1.state).toBe('cancelled');

    // 3. Repeated cancellation returns stable cancelled state
    const cancel1Repeat = await port.cancelJob(job1.jobId);
    expect(cancel1Repeat.state).toBe('cancelled');

    // 4. Completed job cancellation returns stable completed state
    const job2 = await port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await port.getJob(job2.jobId))?.state).toBe('completed');
    const cancel2 = await port.cancelJob(job2.jobId);
    expect(cancel2.state).toBe('completed');
  });

  it('retries in the same conversation and preserves its identity', async () => {
    let idSeq = 0;
    const store = new InMemoryPresentationArtifactStore();
    let shouldFail = true;
    const capability = {
      execute: vi.fn(async () => {
        if (shouldFail) {
          throw Object.assign(new Error('Generation failed'), { code: 'PRESENTATION_FAILED' });
        }
        return {
          artifacts: [
            {
              artifactId: 'art-success',
              createdAt: '2026-01-01T00:00:00.000Z',
              mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              name: 'deck.pptx',
              sizeBytes: 10,
              status: 'ready' as const,
              type: 'pptx',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        };
      }),
    } as never;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => `job-${++idSeq}`,
      },
      scope,
    );

    const initialJob = await port.createJob(input);
    expect(initialJob.jobId).toBe('job-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Verify initial job failed
    const failedJob = await port.getJob('job-1');
    expect(failedJob?.state).toBe('failed');

    // Retry keeps the same conversation
    shouldFail = false;
    const retriedJob = await port.retryJob('job-1');
    expect(retriedJob.jobId).toBe('job-1');
    expect(retriedJob.state).toBe('queued');

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Original job remains failed
    const originalAfterRetry = await port.getJob('job-1');
    expect(originalAfterRetry?.state).toBe('completed');

    // New job succeeds
    const completedRetriedJob = await port.getJob('job-1');
    expect(completedRetriedJob?.state).toBe('completed');
    expect(completedRetriedJob?.artifactIds).toEqual(['art-success']);
  });

  it('resumes only the latest unfinished edit instead of replaying a stale backlog', async () => {
    let calls = 0;
    const capability = {
      execute: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('Initial failure');
        return new Promise(() => undefined);
      }),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'x',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-latest-only',
      },
      scope,
    );
    await port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const internal = port as unknown as {
      jobs: Map<string, { job: { messages: any[] } }>;
    };
    const entry = internal.jobs.get('job-latest-only')!;
    entry.job.messages = [
      {
        content: 'older failed template edit',
        createdAt: '2026-01-01T00:00:01.000Z',
        error: 'old error',
        requestId: 'old',
        status: 'failed',
        target: { type: 'deck' },
      },
      {
        content: 'stale queued template edit',
        createdAt: '2026-01-01T00:00:02.000Z',
        requestId: 'stale-queued',
        status: 'queued',
        target: { type: 'deck' },
      },
      {
        content: 'latest queued template edit',
        createdAt: '2026-01-01T00:00:03.000Z',
        error: 'transient error',
        requestId: 'latest-queued',
        status: 'queued',
        target: { type: 'deck' },
      },
    ];

    await port.retryJob('job-latest-only');

    expect(
      entry.job.messages.map(({ error, requestId, status }) => ({ error, requestId, status })),
    ).toEqual([
      { error: 'old error', requestId: 'old', status: 'failed' },
      {
        error: 'Skipped because a newer edit was resumed.',
        requestId: 'stale-queued',
        status: 'failed',
      },
      { error: undefined, requestId: 'latest-queued', status: 'queued' },
    ]);
  });

  describe('R4-A Acceptance: 4-phase cancellation & failure persistence', () => {
    it('cancels during planner phase and maintains terminal cancelled state', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let plannerAbortSignal: AbortSignal | undefined;

      const capability = {
        execute: vi.fn(async (_scope, _input, context) => {
          plannerAbortSignal = context.plannerContext.abortSignal;
          // Simulate long running planner
          return new Promise((_, reject) => {
            context.plannerContext.abortSignal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Planner aborted'), {
                  code: 'PRESENTATION_WORKER_CANCELLED',
                }),
              );
            });
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-planner',
        },
        scope,
      );

      await port.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-planner');
      expect(cancelled.state).toBe('cancelled');
      expect(plannerAbortSignal?.aborted).toBe(true);

      // Repeat cancel is idempotent
      const repeat = await port.cancelJob('job-cancel-planner');
      expect(repeat.state).toBe('cancelled');
    });

    it('cancels during image generation phase and aborts image provider call', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let imageAbortSignal: AbortSignal | undefined;

      const imageGenerationCapability = {
        generate: vi.fn(async (_scope, _slots, options) => {
          imageAbortSignal = options.signal;
          return new Promise((_, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Image generation aborted'), { code: 'IMAGE_CANCELLED' }),
              );
            });
          });
        }),
      } as unknown as ImageGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: { execute: vi.fn() } as unknown as PresentationGenerationCapability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-img',
          imageGenerationCapability,
        },
        scope,
      );

      await port.createJob({
        ...input,
        options: { imageSlots: [{ prompt: 'img', slideId: 's1', slotId: 'hero' }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-img');
      expect(cancelled.state).toBe('cancelled');
      expect(imageAbortSignal?.aborted).toBe(true);

      const queried = await port.getJob('job-cancel-img');
      expect(queried?.state).toBe('cancelled');
    });

    it('cancels during worker page rendering / export phase', async () => {
      const store = new InMemoryPresentationArtifactStore();
      let workerAbortSignal: AbortSignal | undefined;

      const capability = {
        execute: vi.fn(async (_scope, _input, context) => {
          workerAbortSignal = context.workerContext.abortSignal;
          return new Promise((_, reject) => {
            context.workerContext.abortSignal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('Worker cancelled'), {
                  code: 'PRESENTATION_WORKER_CANCELLED',
                }),
              );
            });
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-cancel-worker',
        },
        scope,
      );

      await port.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await port.cancelJob('job-cancel-worker');
      expect(cancelled.state).toBe('cancelled');
      expect(workerAbortSignal?.aborted).toBe(true);
    });

    it('persists specific error codes for IMAGE_BUDGET_EXCEEDED, PRESENTATION_QUALITY_FAILED, and WORKER_FAILED', async () => {
      const store = new InMemoryPresentationArtifactStore();

      // 1. IMAGE_BUDGET_EXCEEDED
      const imageBudgetCap = {
        generate: vi.fn(async () => {
          throw Object.assign(new Error('Budget exceeded'), { code: 'IMAGE_BUDGET_EXCEEDED' });
        }),
      } as unknown as ImageGenerationCapability;

      const portImg = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: { execute: vi.fn() } as unknown as PresentationGenerationCapability,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-budget',
          imageGenerationCapability: imageBudgetCap,
        },
        scope,
      );

      await portImg.createJob({
        ...input,
        options: { imageSlots: [{ prompt: 'exceed', slideId: 's1', slotId: 'img' }] },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const budgetFailedJob = await portImg.getJob('job-err-budget');
      expect(budgetFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'IMAGE_BUDGET_EXCEEDED' }),
        state: 'failed',
      });

      // 2. PRESENTATION_QUALITY_FAILED
      const qualityFailedCap = {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('Quality score too low'), {
            code: 'PRESENTATION_QUALITY_FAILED',
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const portQuality = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: qualityFailedCap,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-quality',
        },
        scope,
      );

      await portQuality.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const qualityFailedJob = await portQuality.getJob('job-err-quality');
      expect(qualityFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'PRESENTATION_QUALITY_FAILED' }),
        state: 'failed',
      });

      // 3. PRESENTATION_WORKER_FAILED
      const workerFailedCap = {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('PPTX generation failed'), {
            code: 'PRESENTATION_WORKER_FAILED',
          });
        }),
      } as unknown as PresentationGenerationCapability;

      const portWorker = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability: workerFailedCap,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: vi.fn(),
              jobId: 'x',
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          idFactory: () => 'job-err-worker',
        },
        scope,
      );

      await portWorker.createJob(input);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const workerFailedJob = await portWorker.getJob('job-err-worker');
      expect(workerFailedJob).toMatchObject({
        error: expect.objectContaining({ code: 'PRESENTATION_WORKER_FAILED' }),
        state: 'failed',
      });
    });
  });
});

const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
    'base64',
  ),
);
const samplePlan = {
  aspectRatio: '16:9',
  planId: 'plan-1',
  sourceVersionIds: ['v1'],
  title: '演示',
  slides: [
    {
      order: 1,
      slideId: 'cover',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="60">Cover</text></svg>',
    },
  ],
};
const pptxProfile = {
  constraints: {
    aspectRatio: '16:9',
    fontFamilies: [],
    fontSizes: [],
    palette: [],
    spacing: {
      horizontalGaps: [],
      margins: { height: 0, width: 0, x: 0, y: 0 },
      verticalGaps: [],
    },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  layouts: [],
  name: 'Watercolor',
  schemaVersion: 1 as const,
  source: { kind: 'pptx' as const, sha256: 'abc' },
  templateId: 'tmpl-pptx',
  versionId: 'ver-1',
  warnings: [],
};
const templateVisual = {
  analyzedAt: '2026-01-01T00:00:00.000Z',
  components: [],
  families: [
    {
      artwork: 'wash',
      composition: 'open',
      id: 'f1',
      name: 'cover',
      pages: [1, 2, 3, 4],
      palette: ['#123456'],
      preserve: [],
      typography: 'serif',
    },
  ],
  guidance: 'keep the watercolor language',
  model: 'vision',
  pages: [1, 2, 3, 4].map((page) => ({
    height: 788,
    nativeTextCount: 0,
    page,
    ref: `template-page-${page}`,
    width: 1400,
  })),
  schemaVersion: 1 as const,
  summary: 'watercolor families',
  templateId: 'tmpl-pptx',
  versionId: 'ver-1',
};
const pptxApplication = {
  constraints: pptxProfile.constraints,
  layouts: pptxProfile.layouts,
  name: pptxProfile.name,
  templateId: pptxProfile.templateId,
  versionId: pptxProfile.versionId,
  visual: templateVisual,
};

describe('PresentationGenerationPort completed-state template application', () => {
  const readyArtifact = {
    artifactId: 'a1',
    createdAt: '2026-01-01T00:00:00.000Z',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    name: 'deck.pptx',
    sizeBytes: 3,
    status: 'ready' as const,
    type: 'pptx',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const seedTemplatePages = async (store: InMemoryPresentationArtifactStore) => {
    for (const page of templateVisual.pages) {
      await store.put(scope, {
        artifactId: page.ref,
        bytes: png,
        mimeType: 'image/png',
        name: `${page.ref}.png`,
        type: 'image',
      });
    }
  };

  const createCapability = (planCalls: unknown[] = []) =>
    ({
      execute: vi.fn(async (_scope, _input, context) => {
        const plan = context.initialPlan ?? samplePlan;
        const prepared = context.preparePlan ? await context.preparePlan(plan) : plan;
        return { artifacts: [readyArtifact], plan: prepared };
      }),
      plan: vi.fn(async (_input, context) => {
        planCalls.push(context.trustedImages);
        return samplePlan;
      }),
    }) as unknown as PresentationGenerationCapability;

  it('binds a deck storyboard before planning and performs one bounded visual repair pass', async () => {
    const directedInput = {
      ...input,
      options: { outline: [{ title: 'Cover' }] },
      slideCount: 1,
      template: 'tmpl-pptx',
    };
    const designProgram = {
      archetypes: [
        {
          assetPolicy: [],
          compositionRules: ['keep the title anchor'],
          evidencePages: [1],
          familyId: 'f1',
          id: 'archetype-f1',
          name: 'Cover',
          readingFlow: 'left to right',
          regions: [],
          roles: ['cover'],
          whitespace: 'open center',
        },
      ],
      cadence: { bodyFamilyIds: [], openingFamilyId: 'f1', rules: ['open quietly'] },
      flexibilities: ['artwork subject may change'],
      invariants: ['keep watercolor texture'],
      schemaVersion: 1,
      tokens: {
        artwork: ['watercolor'],
        palette: ['#123456'],
        surface: ['paper'],
        typography: ['serif'],
      },
    };
    const application = {
      ...pptxApplication,
      visual: { ...templateVisual, designProgram, schemaVersion: 3 as const },
    };
    const storyboard = {
      deckRationale: 'Open with one calm visual.',
      inputFingerprint: presentationStoryboardInputFingerprint(directedInput),
      rhythm: ['quiet cover'],
      schemaVersion: 1 as const,
      slides: [
        {
          archetypeId: 'archetype-f1',
          assetMode: 'none' as const,
          componentIds: [],
          compositionIntent: 'Keep the center open.',
          continuity: 'Establish the paper texture.',
          familyId: 'f1',
          role: 'cover' as const,
          slideId: 'slide-1',
        },
      ],
      templateId: 'tmpl-pptx',
      versionId: 'ver-1',
    };
    const visualStoryboardPlanner = { plan: vi.fn(async () => storyboard) };
    const visualCritic = {
      review: vi
        .fn()
        .mockResolvedValueOnce({
          issues: [
            {
              category: 'spacing',
              evidence: 'title is too close to the edge',
              instruction: 'move the title right by one margin unit',
              severity: 'major',
              slideId: 'cover',
            },
          ],
          passed: false,
          schemaVersion: 1,
          summary: 'one spacing issue',
        })
        .mockResolvedValueOnce({
          issues: [],
          passed: true,
          schemaVersion: 1,
          summary: 'spacing now matches the template',
        }),
    };
    let receivedInput: Record<string, unknown> | undefined;
    const capability = {
      execute: vi.fn(async (_scope, jobInput, context) => {
        receivedInput = structuredClone(jobInput);
        const prepared = await context.preparePlan({
          ...samplePlan,
          slides: samplePlan.slides.map((slide) => ({
            ...slide,
            metadata: { outline: ['Original point'], title: 'Original title' },
            notes: 'Original speaker notes',
          })),
        });
        return { artifacts: [readyArtifact], plan: prepared };
      }),
      plan: vi.fn(async () => ({
        ...samplePlan,
        planId: 'visual-repair-plan',
        slides: samplePlan.slides.map((slide) => ({
          ...slide,
          metadata: { outline: ['Wrong replacement point'], title: 'Wrong replacement title' },
          notes: 'Wrong replacement notes',
          svg: slide.svg.replace('Cover', 'Repaired cover'),
        })),
      })),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-directed',
        templateLibrary: {
          get: vi.fn(async () => ({
            ...pptxProfile,
            source: { kind: 'plan' as const, planId: 'source-plan' },
          })),
          resolve: vi.fn(async () => structuredClone(application)),
        } as never,
        visualCritic: visualCritic as never,
        visualStoryboardPlanner,
      },
      scope,
    );

    await port.createJob(directedInput);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-directed'))?.state).toBe('completed'),
    );
    expect(visualStoryboardPlanner.plan).toHaveBeenCalledOnce();
    expect(receivedInput?.options).toEqual(
      expect.objectContaining({ visualStoryboard: storyboard }),
    );
    expect(capability.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ visualStoryboard: storyboard }),
      }),
      expect.objectContaining({
        revision: expect.objectContaining({
          target: { slideNumber: 1, type: 'slide' },
        }),
      }),
    );
    expect(visualCritic.review).toHaveBeenCalledTimes(2);
    await expect(port.readPlan('job-directed')).resolves.toMatchObject({
      plan: {
        designSpec: {
          templateVisualReview: {
            repaired: true,
            templateId: 'tmpl-pptx',
            versionId: 'ver-1',
          },
        },
        slides: [
          expect.objectContaining({
            metadata: { outline: ['Original point'], title: 'Original title' },
            notes: 'Original speaker notes',
            svg: expect.stringContaining('Repaired cover'),
          }),
        ],
      },
    });
  });

  it('replans cached initial assets when a retry learns a newer template context', async () => {
    const directedInput = {
      ...input,
      options: { outline: [{ title: 'Cover' }] },
      slideCount: 1,
      template: 'tmpl-pptx',
    };
    const designProgram = {
      archetypes: [
        {
          assetPolicy: [],
          compositionRules: ['keep the title anchor'],
          evidencePages: [1],
          familyId: 'f1',
          id: 'archetype-f1',
          name: 'Cover',
          readingFlow: 'left to right',
          regions: [],
          roles: ['cover'],
          whitespace: 'open center',
        },
      ],
      cadence: { bodyFamilyIds: [], openingFamilyId: 'f1', rules: ['open quietly'] },
      flexibilities: ['artwork subject may change'],
      invariants: ['keep watercolor texture'],
      schemaVersion: 1,
      tokens: {
        artwork: ['watercolor'],
        palette: ['#123456'],
        surface: ['paper'],
        typography: ['serif'],
      },
    };
    const learnedVisual = { ...templateVisual, designProgram, schemaVersion: 3 as const };
    const storyboard = {
      deckRationale: 'Open with one calm visual.',
      inputFingerprint: presentationStoryboardInputFingerprint(directedInput),
      rhythm: ['quiet cover'],
      schemaVersion: 1 as const,
      slides: [
        {
          archetypeId: 'archetype-f1',
          assetMode: 'generate' as const,
          componentIds: [],
          compositionIntent: 'Keep the center open.',
          continuity: 'Establish the paper texture.',
          familyId: 'f1',
          role: 'cover' as const,
          slideId: 'slide-1',
        },
      ],
      templateId: 'tmpl-pptx',
      versionId: 'ver-1',
    };
    const prepare = vi.fn(async (assetInput) => ({
      assetArtifactIds: [],
      input: assetInput.jobInput,
      intents: [],
    }));
    let saved = {
      initialAssetsComplete: true,
      input: directedInput,
      job: {
        aspectRatio: '16:9' as const,
        createdAt: '2026-01-01T00:00:00.000Z',
        jobId: 'job-stale-assets',
        messages: [],
        projectId: 'project',
        revisions: [],
        slideCount: 1,
        state: 'failed' as const,
        title: directedInput.title,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      preparedAssets: {
        initial: {
          assetArtifactIds: ['stale-asset'],
          input: {
            ...directedInput,
            options: {
              ...directedInput.options,
              templateVersionId: 'ver-1',
              templateVisual,
            },
          },
          intents: [],
        },
      },
    };
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability: createCapability(),
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        repository: {
          getJob: vi.fn(async () => structuredClone(saved) as never),
          saveJob: vi.fn(async (_scope, snapshot) => {
            saved = structuredClone(snapshot) as typeof saved;
          }),
        },
        revisionAssetPlanner: { prepare, prepareInitial: vi.fn() } as never,
        templateLibrary: {
          get: vi.fn(async () => ({
            ...pptxProfile,
            source: { kind: 'plan' as const, planId: 'source-plan' },
          })),
          resolve: vi.fn(async () => ({
            ...pptxApplication,
            visual: learnedVisual,
          })),
        } as never,
        visualStoryboardPlanner: { plan: vi.fn(async () => storyboard) },
      },
      scope,
    );

    await port.retryJob('job-stale-assets');
    await vi.waitFor(async () =>
      expect((await port.getJob('job-stale-assets'))?.state).toBe('completed'),
    );

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        jobInput: expect.objectContaining({
          options: expect.objectContaining({
            templateVisual: learnedVisual,
            visualStoryboard: storyboard,
          }),
        }),
      }),
    );
    expect(saved.preparedAssets.initial.input.options).toEqual(
      expect.objectContaining({
        templateVisual: learnedVisual,
        visualStoryboard: storyboard,
      }),
    );
  });

  it('keeps valid pages when the optional visual repair model is unavailable', async () => {
    const capability = {
      execute: vi.fn(async (_scope, _input, context) => {
        const prepared = await context.preparePlan(samplePlan);
        return { artifacts: [readyArtifact], plan: prepared };
      }),
      plan: vi.fn(async () => {
        throw Object.assign(new Error('Multimodal planner returned empty response'), {
          code: 'CHAT_UNAVAILABLE',
        });
      }),
    } as unknown as PresentationGenerationCapability;
    const visualCritic = {
      review: vi.fn(async () => ({
        issues: [
          {
            category: 'spacing' as const,
            evidence: 'The title margin is tighter than the reference.',
            instruction: 'Move the title inward while preserving all content.',
            severity: 'major' as const,
            slideId: 'cover',
          },
        ],
        passed: false,
        schemaVersion: 1 as const,
        summary: 'One bounded spacing repair is recommended.',
      })),
    };
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-repair-fallback',
        templateLibrary: {
          get: vi.fn(async () => ({
            ...pptxProfile,
            source: { kind: 'plan' as const, planId: 'source-plan' },
          })),
          resolve: vi.fn(async () => structuredClone(pptxApplication)),
        } as never,
        visualCritic,
      },
      scope,
    );

    await port.createJob({ ...input, template: 'tmpl-pptx' });
    await vi.waitFor(async () =>
      expect((await port.getJob('job-repair-fallback'))?.state).toBe('completed'),
    );

    expect(capability.plan).toHaveBeenCalledOnce();
    expect(visualCritic.review).toHaveBeenCalledOnce();
    await expect(port.readPlan('job-repair-fallback')).resolves.toMatchObject({
      plan: {
        designSpec: {
          templateVisualReview: {
            repairFailures: [{ code: 'CHAT_UNAVAILABLE', slideId: 'cover' }],
            repaired: false,
            repairedSlideIds: [],
          },
        },
      },
    });
  });

  it('analyzes a PPTX template, re-resolves visual, then prepares revision assets', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await seedTemplatePages(store);
    const order: string[] = [];
    let latestSaved:
      | { input?: { options?: Record<string, unknown>; template?: string } }
      | undefined;
    const resolve = vi.fn(async () => {
      order.push('resolve');
      return structuredClone(pptxApplication);
    });
    const prepare = vi.fn(async (assetInput) => {
      order.push('prepareAssets');
      return { assetArtifactIds: [], input: assetInput.jobInput, intents: [] };
    });
    const planCalls: unknown[] = [];
    const capability = createCapability(planCalls);
    vi.mocked(capability.plan).mockImplementation(async (_input, context) => {
      order.push('plan');
      planCalls.push(context.trustedImages);
      return samplePlan;
    });
    const invoke = vi.fn(async (name, payload, invocation) => {
      if (name === 'presentation.template.analyzeVisual') {
        order.push('analyzeVisual');
        expect(invocation).toEqual(
          expect.objectContaining({
            jobId: 'job-template',
            onEvent: expect.any(Function),
            scope,
            signal: expect.any(AbortSignal),
          }),
        );
        expect(payload).toEqual({ templateId: 'tmpl-pptx', versionId: 'ver-1' });
        return structuredClone(templateVisual);
      }
      if (name === 'presentation.assets.prepare') {
        return prepare({ ...payload, jobId: invocation.jobId, scope, signal: invocation.signal });
      }
      throw new Error(`unexpected invoke ${name}`);
    });
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        atomicRuntime: {
          acquire: vi.fn(async () => () => undefined),
          catalog: vi.fn(async () => [{ name: 'presentation.template.analyzeVisual' }]),
          invoke,
        } as never,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-template',
        repository: {
          getJob: vi.fn(async () => latestSaved as never),
          saveJob: vi.fn(async (_scope, snapshot) => {
            latestSaved = structuredClone(snapshot);
          }),
        },
        revisionAssetPlanner: { prepare, prepareInitial: vi.fn() } as never,
        templateLibrary: {
          get: vi.fn(async () => structuredClone(pptxProfile)),
          resolve,
        } as never,
      },
      scope,
    );

    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-template'))?.state).toBe('completed'),
    );
    order.length = 0;
    prepare.mockClear();

    await port.applyTemplate('job-template', {
      requestId: 'apply-watercolor',
      templateId: 'tmpl-pptx',
      versionId: 'ver-1',
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('job-template'))?.state).toBe('completed'),
    );

    const analyzed = order.indexOf('analyzeVisual');
    expect(analyzed).toBeGreaterThan(-1);
    const afterAnalyze = order.slice(analyzed);
    expect(afterAnalyze.indexOf('resolve')).toBeGreaterThan(-1);
    expect(afterAnalyze.indexOf('resolve')).toBeLessThan(afterAnalyze.indexOf('prepareAssets'));
    expect(afterAnalyze.indexOf('prepareAssets')).toBeLessThan(afterAnalyze.indexOf('plan'));
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        jobInput: expect.objectContaining({
          options: expect.objectContaining({
            templateVersionId: 'ver-1',
            templateVisual,
          }),
          template: 'tmpl-pptx',
        }),
        revision: expect.objectContaining({
          requestId: 'apply-watercolor',
          template: { templateId: 'tmpl-pptx', versionId: 'ver-1' },
        }),
      }),
    );
    expect(latestSaved?.input?.options?.templateVisual).toEqual(templateVisual);
    expect(planCalls.at(-1)).toEqual(
      templateVisual.pages.map((page) => ({
        base64: Buffer.from(png).toString('base64'),
        mimeType: 'image/png',
        ref: page.ref,
      })),
    );
  });

  it('still invokes analyzeVisual and resolve when the PPTX visual is already cached', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const resolve = vi.fn(async () => structuredClone(pptxApplication));
    const capability = createCapability();
    const invoke = vi.fn(async (name, payload) => {
      if (name === 'presentation.template.analyzeVisual') return structuredClone(templateVisual);
      if (name === 'presentation.assets.prepare')
        return { assetArtifactIds: [], input: payload.jobInput, intents: [] };
      throw new Error(`unexpected invoke ${name}`);
    });
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        atomicRuntime: {
          acquire: vi.fn(async () => () => undefined),
          catalog: vi.fn(async () => [{ name: 'presentation.template.analyzeVisual' }]),
          invoke,
        } as never,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-cached',
        revisionAssetPlanner: {
          prepare: vi.fn(async (assetInput) => ({
            assetArtifactIds: [],
            input: assetInput.jobInput,
            intents: [],
          })),
          prepareInitial: vi.fn(),
        } as never,
        templateLibrary: {
          get: vi.fn(async () => structuredClone(pptxProfile)),
          resolve,
        } as never,
      },
      scope,
    );

    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-cached'))?.state).toBe('completed'),
    );
    invoke.mockClear();
    resolve.mockClear();

    await port.applyTemplate('job-cached', { requestId: 'apply-cached', templateId: 'tmpl-pptx' });
    await vi.waitFor(async () =>
      expect((await port.getJob('job-cached'))?.state).toBe('completed'),
    );
    expect(invoke).toHaveBeenCalledWith(
      'presentation.template.analyzeVisual',
      { templateId: 'tmpl-pptx', versionId: 'ver-1' },
      expect.objectContaining({ jobId: 'job-cached', signal: expect.any(AbortSignal) }),
    );
    expect(resolve).toHaveBeenCalled();
  });

  it('fails a PPTX apply without visual analysis and does not persist the new template', async () => {
    const store = new InMemoryPresentationArtifactStore();
    let latestSaved:
      | {
          input: { options?: Record<string, unknown>; template?: string };
          plan?: unknown;
        }
      | undefined;
    const invoke = vi.fn();
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        atomicRuntime: {
          acquire: vi.fn(async () => () => undefined),
          catalog: vi.fn(async () => []),
          invoke,
        } as never,
        capability: createCapability(),
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-missing-visual',
        repository: {
          getJob: vi.fn(async () => latestSaved as never),
          saveJob: vi.fn(async (_scope, snapshot) => {
            latestSaved = structuredClone(snapshot) as typeof latestSaved;
          }),
        },
        templateLibrary: {
          get: vi.fn(async () => structuredClone(pptxProfile)),
          resolve: vi.fn(async () => ({
            constraints: pptxProfile.constraints,
            layouts: [],
            name: pptxProfile.name,
            templateId: pptxProfile.templateId,
            versionId: pptxProfile.versionId,
          })),
        } as never,
      },
      scope,
    );

    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-missing-visual'))?.state).toBe('completed'),
    );
    const completedPlan = latestSaved?.plan;
    expect(completedPlan).toEqual(samplePlan);

    await port.applyTemplate('job-missing-visual', {
      requestId: 'apply-missing',
      templateId: 'tmpl-pptx',
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('job-missing-visual'))?.state).toBe('failed'),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(latestSaved?.plan).toEqual(completedPlan);
    expect(latestSaved?.input.template).toBeUndefined();
    expect(latestSaved?.input.options?.templateVisual).toBeUndefined();
    expect((await port.getJob('job-missing-visual'))?.error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('passes every verified template page to the initial planner, not only the first two', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await seedTemplatePages(store);
    let trustedImages: unknown;
    const capability = {
      execute: vi.fn(async (_scope, _input, context) => {
        trustedImages = context.plannerContext.trustedImages;
        const plan = context.initialPlan ?? samplePlan;
        const prepared = context.preparePlan ? await context.preparePlan(plan) : plan;
        return { artifacts: [readyArtifact], plan: prepared };
      }),
      plan: vi.fn(),
    } as unknown as PresentationGenerationCapability;
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        atomicRuntime: {
          acquire: vi.fn(async () => () => undefined),
          catalog: vi.fn(async () => [{ name: 'presentation.template.analyzeVisual' }]),
          invoke: vi.fn(async (name) => {
            if (name === 'presentation.template.analyzeVisual')
              return structuredClone(templateVisual);
            throw new Error(`unexpected invoke ${name}`);
          }),
        } as never,
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-pages',
        templateLibrary: {
          get: vi.fn(async () => structuredClone(pptxProfile)),
          resolve: vi.fn(async () => structuredClone(pptxApplication)),
        } as never,
      },
      scope,
    );

    await port.createJob({ ...input, template: 'tmpl-pptx' });
    await vi.waitFor(async () => expect((await port.getJob('job-pages'))?.state).toBe('completed'));
    expect(trustedImages).toEqual(
      templateVisual.pages.map((page) => ({
        base64: Buffer.from(png).toString('base64'),
        mimeType: 'image/png',
        ref: page.ref,
      })),
    );
  });

  it('keeps plan templates on the existing path when visual analysis is absent', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const invoke = vi.fn();
    const resolve = vi.fn(async () => ({
      constraints: pptxProfile.constraints,
      layouts: [],
      name: 'From plan',
      templateId: 'tmpl-plan',
      versionId: 'ver-plan',
    }));
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        atomicRuntime: {
          acquire: vi.fn(async () => () => undefined),
          catalog: vi.fn(async () => []),
          invoke,
        } as never,
        capability: createCapability(),
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'job-plan-template',
        templateLibrary: {
          get: vi.fn(async () => ({
            ...pptxProfile,
            source: { kind: 'plan' as const, planId: 'plan-1' },
            templateId: 'tmpl-plan',
            versionId: 'ver-plan',
          })),
          resolve,
        } as never,
      },
      scope,
    );

    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-plan-template'))?.state).toBe('completed'),
    );
    await port.applyTemplate('job-plan-template', {
      requestId: 'apply-plan',
      templateId: 'tmpl-plan',
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('job-plan-template'))?.state).toBe('completed'),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalled();
  });
});
