import { InMemoryPresentationArtifactStore } from './artifact-store';
import { createDeckVisualSystem } from './deck-visual-system';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import type { ImageGenerationCapability } from './image-generation-capability';
import type { PresentationRevisionAssetPlanner } from './revision-assets';
import type { PresentationVisualCritic } from './visual-critic';
import { presentationStoryboardInputFingerprint } from './visual-storyboard';

const scope = { request: new Request('https://example.test'), userId: 'u1', sessionId: 's1' };
const input = { notebookId: 'n1', title: '演示', sourceVersionIds: ['v1'] };

describe('PresentationGenerationPort', () => {
  it('restores a detached native block from its saved source before final review', async () => {
    const directed = {
      ...input,
      slideCount: 1,
      options: {
        style: '商务',
        outline: [{ title: '企业师资', keyPoints: ['企业导师参与教学', '教师参与企业实践'] }],
        visualStoryboard: { slides: [{ slideId: 'slide-1', role: 'content' }] },
        contentIntents: {
          slides: [
            {
              slideId: 'slide-1',
              claim: '双向协同育人',
              formulas: [],
              visualKind: 'scientific-diagram',
              visualReason: '协作关系',
              visuals: [
                {
                  id: 'flow',
                  kind: 'scientific-diagram',
                  renderer: 'native',
                  required: true,
                  brief: '双向协作',
                },
              ],
            },
          ],
        },
      },
    };
    const master = createDeckVisualSystem(directed)!;
    const plan = {
      planId: 'saved',
      title: input.title,
      aspectRatio: '16:9',
      sourceVersionIds: ['v1'],
      designSpec: { contentPolicyVersion: 1 },
      slides: [
        {
          slideId: 'slide-1',
          order: 1,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-deck-body="true"><text x="48" y="200" font-size="24">原有教师实践说明</text></g></svg>',
          notes: '原始材料出处',
          metadata: {
            title: '企业师资',
            deckVisualSystemId: master.id,
            outline: directed.options.outline[0].keyPoints,
            contentBlocks: [
              {
                id: 'flow',
                kind: 'scientific-diagram',
                title: '双向协作',
                rect: master.body,
                provenance: { kind: 'source', reference: '报告 attachment-private' },
                spec: {
                  type: 'graph',
                  nodes: [
                    { id: 'a', label: '企业导师', x: 0.2, y: 0.5 },
                    { id: 'b', label: '教师实践', x: 0.8, y: 0.5 },
                  ],
                  edges: [{ from: 'a', to: 'b' }],
                },
              },
            ],
          },
        },
      ],
    };
    const execute = vi.fn(async (_scope, _input, context) => ({
      artifacts: [],
      plan: await context.preparePlan(plan),
    }));
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability: { execute, plan: vi.fn() } as never,
        idFactory: () => 'detached-block',
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            jobId: 'ignored',
            convert: vi.fn(),
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
      },
      scope,
    );
    await port.createJob({
      ...directed,
      options: { ...directed.options, deckVisualSystem: master },
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('detached-block'))?.state).toBe('completed'),
    );
    const completed = await execute.mock.results[0].value;
    expect(completed.plan.slides[0].svg).toContain('data-scientific-diagram="flow"');
    expect(completed.plan.slides[0].svg).not.toContain('attachment-private');
    expect(completed.plan.slides[0].notes).toContain('原始材料出处');
  });
  it('uses an edit received before initial completion in the first render instead of replaying the whole deck', async () => {
    let saved = {
      input: { ...input, slideCount: 1 },
      job: {
        jobId: 'initial-edit',
        projectId: 'p',
        title: input.title,
        aspectRatio: '16:9',
        slideCount: 1,
        state: 'failed',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        revisions: [],
        messages: [
          {
            requestId: 'reuse-source-figures',
            content: '复用文档原图并统一样式',
            target: { type: 'deck' },
            status: 'queued',
            createdAt: '2026-01-01',
          },
        ],
      },
    };
    const compile = vi.fn(async () => ({
      inputFingerprint: 'compiled',
      slides: [
        {
          slideId: 'slide-1',
          claim: '原始资料',
          formulas: [],
          visualKind: 'none',
          visualReason: '文字',
          visuals: [],
        },
      ],
    }));
    const capability = {
      plan: vi.fn(),
      execute: vi.fn(async (_scope: any, jobInput: any, context: any) => {
        expect(jobInput.options.contentRevision.requestId).toBe('reuse-source-figures');
        const plan = await context.preparePlan({
          planId: 'first',
          title: input.title,
          aspectRatio: '16:9',
          sourceVersionIds: ['v1'],
          slides: [
            {
              slideId: 'slide-1',
              order: 1,
              svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="48" y="100" font-size="24">已批准的内容</text></svg>',
            },
          ],
        });
        return { artifacts: [], plan };
      }),
    };
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability: capability as never,
        contentCompiler: { compile } as never,
        repository: {
          getJob: vi.fn(async () => structuredClone(saved) as never),
          saveJob: vi.fn(async (_scope, snapshot) => {
            saved = structuredClone(snapshot) as typeof saved;
          }),
        },
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            jobId: 'ignored',
            convert: vi.fn(),
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
      },
      scope,
    );
    await port.retryJob('initial-edit');
    await vi.waitFor(async () =>
      expect((await port.getJob('initial-edit'))?.state).toBe('completed'),
    );
    expect(compile).toHaveBeenCalledOnce();
    expect(capability.plan).not.toHaveBeenCalled();
    expect(saved.job.messages[0].status).toBe('applied');
  });
  it('restores complete raster bindings before checking a resumed draft for missing assets', async () => {
    const directedInput = {
      ...input,
      slideCount: 1,
      options: {
        contentIntents: {
          slides: [
            {
              slideId: 'cover',
              claim: 'Keep the prepared figure',
              formulas: [],
              visualKind: 'illustration',
              visualReason: 'Prepared image',
              visuals: [
                {
                  id: 'visual-1',
                  kind: 'illustration',
                  brief: 'A campus',
                  required: true,
                  renderer: 'image',
                },
              ],
            },
          ],
        },
      },
    };
    const preparedInput = {
      ...directedInput,
      options: {
        ...directedInput.options,
        generatedImageSlots: [
          {
            slideId: 'cover',
            slotId: 'initial-assets:visual-1',
            state: 'ready',
            assetRefs: [{ ref: 'image-owned' }],
            visualBinding: { visualId: 'visual-1', kind: 'illustration', origin: 'generated' },
          },
        ],
      },
    };
    let saved = {
      initialAssetsComplete: true,
      input: directedInput,
      job: {
        jobId: 'job-cached-raster',
        projectId: 'project',
        title: input.title,
        aspectRatio: '16:9',
        slideCount: 1,
        state: 'failed',
        messages: [],
        revisions: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      preparedAssets: {
        initial: { input: preparedInput, assetArtifactIds: ['image-owned'], intents: [] },
      },
    };
    const capability = {
      execute: vi.fn(async (_scope, _input, context) => ({
        artifacts: [],
        plan: context.initialPlan,
      })),
      plan: vi.fn(),
    } as unknown as PresentationGenerationCapability;
    const prepare = vi.fn();
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            qualityCheck: vi.fn(),
            jobId: 'ignored',
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
      },
      scope,
    );
    await port.retryJob('job-cached-raster');
    await vi.waitFor(async () =>
      expect((await port.getJob('job-cached-raster'))?.state).toBe('completed'),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(vi.mocked(capability.execute).mock.calls[0]?.[1].options?.generatedImageSlots).toEqual(
      preparedInput.options.generatedImageSlots,
    );
    expect(saved.initialAssetsComplete).toBe(true);
  });
  it('retains minor review findings without rewriting a publishable deck', async () => {
    const initial = { ...samplePlan, designSpec: { contentPolicyVersion: 1 } };
    const capability = {
      execute: vi.fn(),
      plan: vi.fn(),
    } as unknown as PresentationGenerationCapability;
    vi.mocked(capability.execute).mockImplementation(
      async (_scope, _input, context) =>
        ({
          artifacts: [],
          plan: await context.preparePlan!(initial),
        }) as never,
    );
    const review = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      passed: true,
      summary: 'Readable, with a minor style suggestion',
      issues: [
        {
          category: 'continuity',
          severity: 'minor',
          slideId: initial.slides[0].slideId,
          evidence: '页脚标记风格略有差异',
          instruction: '统一页脚标记',
        },
      ],
    });
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        idFactory: () => 'job-minor-advice',
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        visualCritic: { review },
      },
      scope,
    );
    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-minor-advice'))?.state).toBe('completed'),
    );
    expect(capability.plan).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(1);
    const { plan } = await port.readPlan('job-minor-advice');
    expect(plan.designSpec?.templateVisualReview).toMatchObject({
      final: { passed: true, issues: [expect.objectContaining({ severity: 'minor' })] },
    });
  });

  it('updates the visible draft after visual repair even when export remains blocked', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const original = {
      ...samplePlan,
      designSpec: { contentPolicyVersion: 1 },
      slides: [
        {
          ...samplePlan.slides[0],
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="48" y="100" font-size="30">原始错位标题</text></svg>',
        },
      ],
    };
    const corrected = {
      ...original,
      slides: [
        {
          ...original.slides[0],
          svg: original.slides[0].svg.replace('原始错位标题', '修正后的标题'),
        },
      ],
    };
    const capability = {
      execute: vi.fn(),
      plan: vi.fn(),
    } as unknown as PresentationGenerationCapability;
    vi.mocked(capability.execute).mockImplementation(async (_scope, _input, context) => {
      const onDraft = context.plannerContext.onSlideDraft as (
        slide: (typeof original.slides)[number],
      ) => Promise<void>;
      await onDraft(original.slides[0]);
      await context.preparePlan!(original);
      return { artifacts: [] } as never;
    });
    vi.mocked(capability.plan).mockResolvedValue(corrected);
    const port = new PresentationGenerationPort(
      {
        artifactStore: store,
        capability,
        idFactory: () => 'job-visible-repair',
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        visualCritic: {
          review: vi.fn().mockResolvedValue({
            schemaVersion: 1,
            passed: false,
            summary: 'Review still requires repair',
            issues: [
              {
                category: 'composition',
                severity: 'major',
                slideId: original.slides[0].slideId,
                evidence: '文字遮挡',
                instruction: '移动文字',
              },
            ],
          }),
        },
      },
      scope,
    );
    await port.createJob(input);
    await vi.waitFor(async () =>
      expect((await port.getJob('job-visible-repair'))?.state).toBe('failed'),
    );
    const job = await port.getJob('job-visible-repair');
    const draftId = job!.artifactIds!.findLast((id) => id.includes(':draft:'))!;
    const draft = await store.get(scope, draftId);
    const svg = new TextDecoder().decode(draft!.bytes);
    expect(svg).toContain('修正后的标题');
    expect(svg).not.toContain('原始错位标题');
    expect(draft!.metadata?.draft).toBe(true);
    expect(job!.error?.code).toBe('PRESENTATION_QUALITY_FAILED');
  });

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

  it('pins every mounted plugin for the whole run and releases them together', async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const pluginIds = [
      'assets',
      'presentation',
      'presentation-collaboration',
      'skills',
      'teaching',
    ];
    const acquire = vi.fn(async (id: string) => {
      acquired.push(id);
      return () => released.push(id);
    });
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        atomicRuntime: {
          acquire,
          catalog: vi.fn(async () => []),
          invoke: vi.fn(async () => ({})),
          pluginIds: vi.fn(async () => [...pluginIds]),
        } as never,
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
        idFactory: () => 'job-leases',
      },
      scope,
    );

    await port.createJob(input);
    await vi.waitFor(() => expect(released).toHaveLength(pluginIds.length));
    // Every participant is pinned, not only `presentation`, so no plugin can be replaced
    // between two calls of the same job and mix implementation versions.
    expect([...acquired].sort()).toEqual([...pluginIds].sort());
    expect([...released].sort()).toEqual([...pluginIds].sort());
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

  it('resumes the checkpointed revision when later edits died before leaving the transport', async () => {
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
        idFactory: () => 'job-checkpoint-resume',
      },
      scope,
    );
    await port.createJob(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = (
      port as unknown as {
        jobs: Map<
          string,
          {
            job: { messages: Array<Record<string, unknown>> };
            revisionCheckpoint?: { requestId: string };
          }
        >;
      }
    ).jobs.get('job-checkpoint-resume')!;
    entry.revisionCheckpoint = { requestId: 'laid-out' };
    entry.job.messages = [
      {
        content: 'revision that laid out the first pages',
        createdAt: '2026-01-01T00:00:01.000Z',
        error: 'Graph label needs more space',
        requestId: 'laid-out',
        status: 'failed',
        target: { type: 'deck' },
      },
      {
        content: 'later transport failure',
        createdAt: '2026-01-01T00:00:02.000Z',
        error: 'Multimodal chat provider returned HTTP 503',
        requestId: 'transport',
        status: 'failed',
        target: { type: 'deck' },
      },
    ];
    await port.retryJob('job-checkpoint-resume');
    expect(entry.job.messages.map(({ requestId, status }) => ({ requestId, status }))).toEqual([
      { requestId: 'laid-out', status: 'queued' },
      { requestId: 'transport', status: 'failed' },
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

  it('reexports a completed plan without reviving an older failed edit', async () => {
    let saved: any = {
      input,
      plan: samplePlan,
      initialAssetsComplete: true,
      job: {
        jobId: 'completed-export',
        projectId: 'p',
        title: input.title,
        aspectRatio: '16:9',
        slideCount: 1,
        state: 'completed',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        revisions: [],
        messages: [
          {
            requestId: 'old-failed',
            content: '已经被后续修改替代',
            target: { type: 'deck' },
            status: 'failed',
            error: 'Older quality failure',
            createdAt: '2026-01-01',
          },
        ],
      },
    };
    const capability = createCapability();
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability,
        repository: {
          getJob: vi.fn(async () => structuredClone(saved)),
          saveJob: vi.fn(async (_scope, value) => {
            saved = structuredClone(value);
          }),
        },
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            jobId: 'ignored',
            convert: vi.fn(),
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
      },
      scope,
    );
    await port.retryJob('completed-export');
    await vi.waitFor(async () =>
      expect((await port.getJob('completed-export'))?.state).toBe('completed'),
    );
    expect(capability.plan).not.toHaveBeenCalled();
    expect(capability.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ initialPlan: samplePlan }),
    );
    expect(saved.job.messages[0].status).toBe('failed');
  });

  it('binds a deck storyboard and repairs defects newly exposed by the first visual pass', async () => {
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
          issues: [
            {
              category: 'hierarchy',
              evidence: 'the corrected title needs a clearer subtitle hierarchy',
              instruction: 'align the subtitle with the corrected title',
              severity: 'major',
              slideId: 'cover',
            },
          ],
          passed: false,
          schemaVersion: 1,
          summary: 'one hierarchy issue remains',
        })
        .mockResolvedValueOnce({
          issues: [],
          passed: true,
          schemaVersion: 1,
          summary: 'spacing and hierarchy now match the template',
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
    expect(visualCritic.review).toHaveBeenCalledTimes(3);
    expect(capability.plan).toHaveBeenCalledTimes(2);
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

  it('re-prepares required assets a resumed plan never received instead of shipping a blank page', async () => {
    const directedInput = {
      ...input,
      options: {
        contentIntents: {
          slides: [
            {
              claim: 'A split page keeps its figure',
              formulas: [],
              slideId: 'cover',
              visualKind: 'scientific-diagram',
              visualReason: 'Required figure',
              visuals: [
                {
                  brief: 'Convex feasible set with a supporting hyperplane',
                  id: 'visual-1',
                  kind: 'scientific-diagram',
                  renderer: 'image',
                  required: true,
                },
              ],
            },
          ],
        },
      },
      slideCount: 1,
    };
    // The resumed plan carries the page but no asset binding for its required figure.
    const plan = {
      ...samplePlan,
      slides: [
        {
          order: 1,
          slideId: 'cover',
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"></svg>',
        },
      ],
    };
    const prepare = vi.fn(async (assetInput: { jobInput: unknown }) => ({
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
        jobId: 'job-missing-figure',
        messages: [],
        projectId: 'project',
        revisions: [],
        slideCount: 1,
        state: 'failed' as const,
        title: directedInput.title,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      plan,
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
      },
      scope,
    );

    await port.retryJob('job-missing-figure');
    await vi.waitFor(async () =>
      expect((await port.getJob('job-missing-figure'))?.state).toBe('completed'),
    );

    // Without coverage invalidation a completed job skips the assets step and the page stays blank.
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'illustration', instruction: '放大图片显示区域，保留已有图内文字' },
    { kind: 'source-figure', instruction: '原始图片内图例文字偏小，改善可读性' },
  ] as const)(
    'repairs $kind placement without regenerating the owned figure',
    async ({ kind, instruction }) => {
      const store = new InMemoryPresentationArtifactStore();
      await seedTemplatePages(store);
      await store.put(scope, {
        artifactId: 'old-art',
        bytes: png,
        mimeType: 'image/png',
        name: 'old.png',
        type: 'image',
      });
      const capability = createCapability();
      const candidate = {
        ...samplePlan,
        slides: samplePlan.slides.map((slide) => ({
          ...slide,
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/old-art" x="100" y="100" width="600" height="300"/></svg>',
          metadata: {
            visualAssets: [
              {
                visualId: 'subject',
                kind,
                origin: 'provided',
                ref: '/api/runtime/presentation/artifacts/old-art',
              },
            ],
          },
        })),
      };
      vi.mocked(capability.execute).mockImplementation(async (_scope, _input, context) => ({
        artifacts: [readyArtifact],
        plan: await context.preparePlan!(candidate),
        worker: {
          artifacts: [],
          jobId: 'layout-only',
          planId: candidate.planId,
          qualityReport: { passed: true },
        },
      }));
      vi.mocked(capability.plan).mockResolvedValue(candidate as never);
      const prepare = vi.fn<PresentationRevisionAssetPlanner['prepare']>(async (request) => ({
        input: request.jobInput,
        intents: [],
        assetArtifactIds: [],
      }));
      const review = vi
        .fn<PresentationVisualCritic['review']>()
        .mockResolvedValueOnce({
          schemaVersion: 1,
          passed: false,
          summary: '图片可读性',
          issues: [
            {
              slideId: 'cover',
              visualId: 'subject',
              category: 'legibility',
              severity: 'major',
              evidence: '图片在当前页面偏小',
              instruction,
            },
          ],
        })
        .mockResolvedValue({ schemaVersion: 1, passed: true, summary: '已恢复', issues: [] });
      const port = new PresentationGenerationPort(
        {
          artifactStore: store,
          capability,
          idFactory: () => 'layout-only',
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              jobId: 'ignored',
              convert: vi.fn(),
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          templateLibrary: {
            get: vi.fn(async () => ({
              ...pptxProfile,
              source: { kind: 'plan', planId: 'source-plan' },
            })),
            resolve: vi.fn(async () => structuredClone(pptxApplication)),
          } as never,
          revisionAssetPlanner: {
            prepare,
            prepareInitial: vi.fn(async (request) => ({
              input: request.jobInput,
              intents: [],
              assetArtifactIds: [],
            })),
          },
          visualCritic: { review },
        },
        scope,
      );
      await port.createJob({ ...input, template: 'tmpl-pptx' });
      await vi.waitFor(async () => {
        const job = await port.getJob('layout-only');
        expect(job?.error).toBeUndefined();
        expect(job?.state).toBe('completed');
      });
      expect(
        prepare.mock.calls.every(([request]) => request.revision.requestId === 'initial-assets'),
      ).toBe(true);
      expect(capability.plan).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['artwork-style', 'scientific-semantics', 'template-fidelity'] as const)(
    'repairs a critic-confirmed %s mismatch through asset tools and retains page identity',
    async (category) => {
      const store = new InMemoryPresentationArtifactStore();
      await seedTemplatePages(store);
      await store.put(scope, {
        artifactId: 'new-art',
        bytes: png,
        mimeType: 'image/png',
        name: 'art.png',
        type: 'image',
      });
      const capability = createCapability();
      vi.mocked(capability.execute).mockImplementation(async (_scope, _input, context) => {
        const candidate = {
          ...samplePlan,
          slides: samplePlan.slides.map((s) => ({
            ...s,
            metadata: {
              visualAssets: [
                {
                  visualId: 'subject',
                  kind: 'scientific-illustration',
                  origin: 'generated',
                  ref: '/api/runtime/presentation/artifacts/old-art',
                },
              ],
            },
          })),
        };
        return {
          artifacts: [readyArtifact],
          plan: await context.preparePlan!(candidate),
          worker: {
            artifacts: [],
            jobId: 'job-artwork-repair',
            planId: candidate.planId,
            qualityReport: { passed: true },
          },
        };
      });
      vi.mocked(capability.plan).mockImplementation(async () => ({
        ...samplePlan,
        slides: [
          {
            ...samplePlan.slides[0],
            notes: 'Do not overwrite the original notes',
            metadata: {
              visualAssets: [
                {
                  visualId: 'subject',
                  kind: 'scientific-illustration',
                  origin: 'generated',
                  ref: '/api/runtime/presentation/artifacts/new-art',
                },
              ],
            },
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/new-art" width="200" height="200"/></svg>',
          },
        ],
      }));
      const prepare: PresentationRevisionAssetPlanner['prepare'] = vi.fn(async (request) => ({
        assetArtifactIds: request.revision.requestId === 'initial-assets' ? [] : ['new-art'],
        input: request.jobInput,
        intents: [],
      }));
      const visualCritic: PresentationVisualCritic = {
        review: vi
          .fn()
          .mockResolvedValueOnce({
            issues: [
              {
                category,
                visualId: 'subject',
                evidence: 'Photorealistic subject conflicts with watercolor reference',
                instruction:
                  'Redraw only the subject with the learned watercolor brushwork, transparent background',
                severity: 'major',
                slideId: 'cover',
              },
            ],
            passed: false,
            schemaVersion: 1,
            summary: 'Subject style mismatch',
          })
          .mockResolvedValueOnce({
            issues: [],
            passed: true,
            schemaVersion: 1,
            summary: 'Style restored',
          }),
      };
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
          idFactory: () => 'job-artwork-repair',
          templateLibrary: {
            get: vi.fn(async () => ({
              ...pptxProfile,
              source: { kind: 'plan', planId: 'source-plan' },
            })),
            resolve: vi.fn(async () => structuredClone(pptxApplication)),
          } as never,
          revisionAssetPlanner: { prepare, prepareInitial: vi.fn() },
          visualCritic,
        },
        scope,
      );
      await port.createJob({ ...input, template: 'tmpl-pptx' });
      await vi.waitFor(async () =>
        expect((await port.getJob('job-artwork-repair'))?.state).toBe('completed'),
      );
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: expect.objectContaining({
            requestId: expect.stringMatching(/^template-visual-repair:[a-f\d]{24}$/u),
            target: { type: 'slide', slideNumber: 1 },
          }),
          jobInput: expect.objectContaining({
            options: expect.objectContaining({ templateVisual }),
          }),
        }),
      );
      expect(visualCritic.review).toHaveBeenCalledTimes(2);
      const saved = await port.readPlan('job-artwork-repair');
      expect(saved.plan?.slides[0]).toMatchObject({
        slideId: 'cover',
        order: 1,
        metadata: {
          generatedAssetRefs: ['new-art'],
          visualAssets: [
            { visualId: 'subject', ref: '/api/runtime/presentation/artifacts/new-art' },
          ],
        },
      });
      expect(saved.plan?.slides[0].notes).toBe(
        category === 'scientific-semantics' ? 'Do not overwrite the original notes' : undefined,
      );
      expect((await port.getJob('job-artwork-repair'))?.artifactIds).toContain('new-art');
    },
  );

  it('retains a draft and blocks publication when a major visual repair is unavailable', async () => {
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
      expect((await port.getJob('job-repair-fallback'))?.state).toBe('failed'),
    );

    expect(capability.plan).toHaveBeenCalledOnce();
    expect(visualCritic.review).toHaveBeenCalledOnce();
    expect((await port.getJob('job-repair-fallback'))?.error?.code).toBe(
      'PRESENTATION_QUALITY_FAILED',
    );
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
      { input?: { options?: Record<string, unknown>; template?: string } } | undefined;
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
