import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PlannerContext,
  PresentationJobInput,
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { atomicPlanner, atomicWorker, createPresentationAtomicRuntime } from './atomic-plugin';
import { FileCapabilityCapsuleStore } from './capability-memory';
import { FilePresentationStorage } from './file-storage';
import { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { PresentationGenerationPipelineImpl } from './pipeline';
import type {
  PresentationRevisionAssetInput,
  PresentationRevisionAssetPlanner,
  PresentationRevisionAssetResult,
} from './revision-assets';
import { FilePresentationTemplateLibrary, type TemplateApplication } from './templates';
import { InMemoryPresentationPlanWorker } from './worker';

const scope = { sessionId: 'session-a', userId: 'alice', request: new Request('http://localhost') };
const otherScope = { ...scope, sessionId: 'session-b', userId: 'bob' };
const initialPlan: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'atomic-source',
  slides: [
    {
      order: 1,
      slideId: 'first',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="60" fill="#123456" font-size="32">Keep exactly</text></svg>',
    },
    {
      order: 2,
      slideId: 'second',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="40" y="60">Page two</text></svg>',
    },
  ],
  sourceVersionIds: [],
  title: 'Recovery',
};
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Cordis presentation recovery and template scope', () => {
  it('persists successful per-page drafts and restores them into the planner after process recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppt-draft-checkpoint-'));
    roots.push(root);
    const storage = new FilePresentationStorage(root);
    const memory = new FileCapabilityCapsuleStore(join(root, 'memory'));
    const compose = vi.spyOn(memory, 'compose');
    let attempt = 0;
    const execute = vi.fn(async (_scope, plannedInput, context) => {
      expect(plannedInput.options.generatedImageSlots).toEqual([
        {
          slideId: 'first',
          slotId: 'image-1',
          assetRefs: [{ ref: 'owned-image' }],
          state: 'ready',
        },
      ]);
      if (++attempt === 1) {
        await context.plannerContext.onSlideDraft(initialPlan.slides[0]);
        throw new Error('The next page failed');
      }
      expect(context.plannerContext.resumeSlides).toEqual([initialPlan.slides[0]]);
      return { artifacts: [], plan: await context.preparePlan(initialPlan) };
    });
    const makePort = () =>
      new PresentationGenerationPort(
        {
          artifactStore: storage,
          repository: storage,
          capabilityMemory: memory,
          revisionAssetPlanner: {
            prepareInitial: vi.fn(),
            prepare: vi.fn(async (request) => ({
              input: {
                ...request.jobInput,
                options: {
                  ...request.jobInput.options,
                  generatedImageSlots: [
                    {
                      slideId: 'first',
                      slotId: 'image-1',
                      assetRefs: [{ ref: 'owned-image' }],
                      state: 'ready',
                    },
                  ],
                },
              },
              assetArtifactIds: [],
              intents: [],
            })),
          },
          capability: { execute } as unknown as PresentationGenerationCapability,
          idFactory: () => 'draft-job',
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              jobId: 'unused',
              convert: vi.fn(),
              qualityCheck: vi.fn(),
              workspace: { path: root, write: vi.fn() },
            },
          }),
        },
        scope,
      );
    const first = makePort();
    await first.createJob({
      notebookId: 'n',
      title: 'Recovery',
      slideCount: 2,
      sourceVersionIds: [],
      options: { outline: [{ title: 'First' }, { title: 'Second' }] },
    });
    await vi.waitFor(async () => expect((await first.getJob('draft-job'))?.state).toBe('failed'));
    expect((await storage.getJob(scope, 'draft-job'))?.draftCheckpoint?.slides).toHaveLength(1);
    await first.dispose();
    const second = makePort();
    cleanups.push(() => second.dispose());
    await second.retryJob('draft-job');
    await vi.waitFor(async () =>
      expect((await second.getJob('draft-job'))?.state).toBe('completed'),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(compose).toHaveBeenCalledOnce();
  });
  it('restores prepared assets across planner failures and process recreation, retaining all image ids and pinned templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppt-atomic-recovery-'));
    roots.push(root);
    const library = new FilePresentationTemplateLibrary({ root });
    const originalTemplate = await library.learnFromPlan(scope, {
      name: 'Original style',
      plan: initialPlan,
    });
    const prepare = vi.fn(
      async (input: PresentationRevisionAssetInput): Promise<PresentationRevisionAssetResult> => {
        const assetId =
          input.revision.requestId === 'initial-assets' ? 'image-initial' : 'image-edit';
        await new FilePresentationStorage(root).put(input.scope, {
          artifactId: assetId,
          bytes: new Uint8Array([137, 80, 78, 71]),
          metadata: { jobId: input.jobId },
          mimeType: 'image/png',
          name: `${assetId}.png`,
          type: 'image',
        });
        return {
          assetArtifactIds: [assetId],
          input: {
            ...input.jobInput,
            options: { ...input.jobInput.options, generatedImageSlots: [{ assetId }] },
          },
          intents: [{ action: 'generate', slideId: 'second', slotId: assetId }],
        };
      },
    );
    const assets: PresentationRevisionAssetPlanner = {
      prepare,
      prepareInitial: vi.fn(async () => {
        throw new Error('Unexpected initial helper');
      }),
    };
    const failedRequests = new Set<string>();
    const usedTemplates: string[] = [];
    const plan = vi.fn(
      async (_input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan> => {
        const template = context.template as TemplateApplication;
        usedTemplates.push(template.versionId);
        if (!context.basePlan) return structuredClone(initialPlan);
        const revision = context.revision as PresentationMessageInput;
        if (!failedRequests.has(revision.requestId)) {
          failedRequests.add(revision.requestId);
          throw new Error(`Transient planner failure: ${revision.requestId}`);
        }
        const base = context.basePlan as PresentationPlan;
        const assetId = revision.requestId === 'initial-assets' ? 'image-initial' : 'image-edit';
        return {
          ...base,
          slides: base.slides.map((slide) =>
            slide.slideId === 'second'
              ? {
                  ...slide,
                  svg: slide.svg.replace(
                    '</svg>',
                    `<image href="/api/runtime/presentation/artifacts/${assetId}?raw=true" x="500" y="100" width="300" height="300"/></svg>`,
                  ),
                }
              : slide,
          ),
        };
      },
    );
    const createPort = (currentScope = scope) => {
      const storage = new FilePresentationStorage(root);
      const runtime = createPresentationAtomicRuntime({
        artifactStore: storage,
        planner: { plan },
        revisionAssetPlanner: assets,
        templateLibrary: library,
        worker: new InMemoryPresentationPlanWorker(),
      });
      const pipeline = new PresentationGenerationPipelineImpl(
        atomicPlanner(runtime),
        atomicWorker(runtime),
      );
      const port = new PresentationGenerationPort(
        {
          artifactStore: storage,
          atomicRuntime: runtime,
          capability: new PresentationGenerationCapability(pipeline, storage),
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              convert: async () => [
                {
                  bytes: new Uint8Array([80, 75, 1]),
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
          idFactory: () => 'recoverable-job',
          repository: storage,
          revisionAssetPlanner: assets,
          templateLibrary: library,
        },
        currentScope,
      );
      const dispose = async () => {
        await port.dispose();
        await runtime.dispose();
      };
      cleanups.push(dispose);
      return { dispose, port, runtime, storage };
    };

    const first = createPort();
    await first.port.createJob({
      notebookId: 'studio',
      slideCount: 2,
      sourceVersionIds: [],
      template: originalTemplate.templateId,
      title: 'Recovery',
    });
    await vi.waitFor(async () =>
      expect((await first.port.getJob('recoverable-job'))?.state).toBe('failed'),
    );
    await first.dispose();
    expect(prepare).toHaveBeenCalledTimes(1);
    const savedInitial = await first.storage.getJob(scope, 'recoverable-job');
    expect(savedInitial?.preparedAssets?.initial.assetArtifactIds).toEqual(['image-initial']);
    expect(savedInitial?.input.options?.templateVersionId).toBe(originalTemplate.versionId);
    expect(savedInitial?.plan).toEqual(initialPlan);

    const newerTemplate = await library.learnFromPlan(scope, {
      name: 'Updated style',
      plan: initialPlan,
      templateId: originalTemplate.templateId,
    });
    expect(newerTemplate.versionId).not.toBe(originalTemplate.versionId);
    const second = createPort();
    await second.port.retryJob('recoverable-job');
    await vi.waitFor(async () =>
      expect((await second.port.getJob('recoverable-job'))?.state).toBe('completed'),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    const completedInitial = (await second.port.getJob('recoverable-job'))!;
    expect(completedInitial.revisions?.[0].artifactIds).toContain('image-initial');
    expect((await second.port.readPlan('recoverable-job')).plan.slides[0]).toEqual(
      initialPlan.slides[0],
    );
    expect((await second.port.readPlan('recoverable-job')).plan.slides[1].svg).toContain(
      '/api/runtime/presentation/artifacts/image-initial?raw=true',
    );
    const previewId = completedInitial.artifactIds!.find((id) => id.endsWith(':slide:second'))!;
    const preview = await second.storage.get(scope, previewId);
    expect(new TextDecoder().decode(preview!.bytes)).toContain('data:image/png;base64,');
    expect(new Set(usedTemplates)).toEqual(new Set([originalTemplate.versionId]));

    await second.port.applyTemplate('recoverable-job', {
      requestId: 'apply-saved-template',
      templateId: originalTemplate.templateId,
      versionId: originalTemplate.versionId,
    });
    await vi.waitFor(async () =>
      expect((await second.port.getJob('recoverable-job'))?.state).toBe('failed'),
    );
    await second.dispose();
    expect(prepare).toHaveBeenCalledTimes(2);
    const savedEdit = await second.storage.getJob(scope, 'recoverable-job');
    expect(savedEdit?.preparedAssets?.['message:apply-saved-template'].assetArtifactIds).toEqual([
      'image-edit',
    ]);
    expect(savedEdit?.job.messages?.[0]).toMatchObject({
      status: 'failed',
      template: { templateId: originalTemplate.templateId, versionId: originalTemplate.versionId },
    });

    const third = createPort();
    await third.port.retryJob('recoverable-job');
    await vi.waitFor(async () =>
      expect((await third.port.getJob('recoverable-job'))?.state).toBe('completed'),
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    const finalJob = (await third.port.getJob('recoverable-job'))!;
    expect(finalJob.artifactIds).toEqual(expect.arrayContaining(['image-initial', 'image-edit']));
    expect(finalJob.revisions?.at(-1)?.artifactIds).toEqual(
      expect.arrayContaining(['image-initial', 'image-edit']),
    );
    expect(finalJob.messages?.[0]).toMatchObject({
      status: 'applied',
      template: { versionId: originalTemplate.versionId },
    });
    expect(new Set(usedTemplates)).toEqual(new Set([originalTemplate.versionId]));
    expect(
      (await third.runtime.snapshot(scope)).operations.some(
        (operation) => operation.name === 'presentation.render' && operation.state === 'completed',
      ),
    ).toBe(true);

    const outsider = createPort(otherScope);
    expect(await outsider.port.getJob('recoverable-job')).toBeNull();
    expect(await outsider.port.getRawArtifact('image-edit')).toBeNull();
    expect(await outsider.port.listTemplates()).toEqual([]);
    await expect(
      outsider.port.applyTemplate('recoverable-job', {
        requestId: 'steal',
        templateId: originalTemplate.templateId,
        versionId: originalTemplate.versionId,
      }),
    ).rejects.toThrow('does not exist in this scope');
  });
});
