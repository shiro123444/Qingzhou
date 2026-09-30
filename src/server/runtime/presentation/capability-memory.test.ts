import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { AtomicRuntime } from '../atomic-runtime';
import { runSkillSteps } from '../skill-composition';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import {
  appliedTemplateCapsuleIds,
  capabilityMemoryOperations,
  FileCapabilityCapsuleStore,
} from './capability-memory';
import { contentInputFingerprint, type PresentationContentCompiler } from './content-intent';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import { compileTemplateDesignProgram } from './templates/design-program';
import type { TemplateVisualProfile } from './templates/visual-types';

const scope = { userId: 'alice', sessionId: 'first' };
const analysis = {
  summary: '蓝红学术',
  families: [
    {
      id: 'academic',
      name: '蓝红学术课程',
      pages: [1],
      palette: ['#2563eb'],
      typography: '简洁标题',
      composition: '左图右文',
      artwork: '克制留白',
      preserve: ['蓝色标题'],
    },
  ],
  components: [],
  guidance: '保持留白',
  questions: [],
};
const visual: TemplateVisualProfile = {
  ...analysis,
  schemaVersion: 3,
  designProgram: compileTemplateDesignProgram(analysis),
  templateId: 'template',
  versionId: 'v1',
  analyzedAt: '2026-09-22',
  model: 'test',
  learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
  media: [],
  pages: [],
};
const plan: PresentationPlan = {
  planId: 'p1',
  title: '课程',
  aspectRatio: '16:9',
  sourceVersionIds: [],
  designSpec: {
    contentPolicyVersion: 1,
    templateVisualReview: { final: { passed: true, issues: [] } },
  },
  slides: [
    {
      slideId: 'slide-1',
      order: 1,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text font-size="32" x="40" y="60">课程核心结论</text></svg>',
    },
  ],
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qingzhou-memory-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('durable presentation capability memory', () => {
  it('persists verified mixed-scientific recipes without requiring a template and retrieves them across sessions', async () => {
    const store = new FileCapabilityCapsuleStore(root);
    const mixed = {
      ...plan,
      slides: [
        {
          ...plan.slides[0],
          metadata: {
            contentBlocks: [{ kind: 'formula', id: 'core', latex: 'x^2' }],
            visualAssets: [
              {
                visualId: 'brain',
                kind: 'scientific-illustration',
                origin: 'generated',
                ref: '/api/runtime/presentation/artifacts/brain',
              },
              {
                visualId: 'spark',
                kind: 'sticker',
                origin: 'generated',
                ref: '/api/runtime/presentation/artifacts/spark',
              },
            ],
          },
        },
      ],
    };
    const recipes = await store.learnRecipes(scope, mixed);
    expect(recipes.map((r) => r.recipe)).toEqual(
      expect.arrayContaining([
        'formula-with-explanation',
        'scientific-illustration',
        'mixed-scientific',
        'decoration-sticker',
      ]),
    );
    expect(
      recipes.every((r) => r.source.templateId === undefined && r.source.planId === plan.planId),
    ).toBe(true);
    expect(await store.search(scope, '科研插图')).toEqual([]);
    await store.recordOutcome(scope, {
      jobId: 'mixed',
      plan: mixed,
      capsuleIds: recipes.map((r) => r.id),
      result: 'passed',
    });
    const restarted = new FileCapabilityCapsuleStore(root);
    expect(
      (await restarted.search({ ...scope, sessionId: 'later' }, '科研插图')).map((r) => r.recipe),
    ).toContain('mixed-scientific');
    expect(JSON.stringify(recipes)).not.toContain('/api/');
  });
  it('retrieves prior learning for template-free creation and recompiles only the targeted revision content', async () => {
    const store = new FileCapabilityCapsuleStore(root);
    const learned = await store.learn(scope, visual);
    await store.recordOutcome(scope, {
      jobId: 'prior',
      plan,
      capsuleIds: learned.map((c) => c.id),
      result: 'passed',
    });
    const compile = vi.fn<PresentationContentCompiler['compile']>(async (input) => ({
      inputFingerprint: contentInputFingerprint(input),
      slides: [1, 2].map((page) => ({
        slideId: `slide-${page}`,
        claim: '课程结论',
        formulas: [{ id: 'eq', latex: input.options?.contentRevision ? 'x^2' : 'x' }],
        visualKind: 'none',
        visualReason: '公式解释',
      })),
    }));
    const basePlan: PresentationPlan = {
      ...plan,
      slides: [1, 2].map((page) => ({ ...plan.slides[0], order: page, slideId: `slide-${page}` })),
    };
    const execute = vi.fn(async (_scope, _input, context) => ({
      artifacts: [],
      plan: await context.preparePlan(context.initialPlan ?? structuredClone(basePlan)),
    }));
    const revise = vi.fn(async () => structuredClone(basePlan));
    const review = vi.fn(async () => ({
      schemaVersion: 1 as const,
      passed: true,
      issues: [],
      summary: '逐页通过',
    }));
    const port = new PresentationGenerationPort(
      {
        artifactStore: new InMemoryPresentationArtifactStore(),
        capability: { execute, plan: revise } as unknown as PresentationGenerationCapability,
        capabilityMemory: new FileCapabilityCapsuleStore(root),
        contentCompiler: { compile },
        contextFactory: () => ({
          plannerContext: {},
          workerContext: {
            convert: vi.fn(),
            jobId: 'ignored',
            qualityCheck: vi.fn(),
            workspace: { path: '/tmp', write: vi.fn() },
          },
        }),
        idFactory: () => 'new-session-job',
        visualCritic: { review },
      },
      { ...scope, sessionId: 'second', request: new Request('https://example.test') },
    );
    await port.createJob({
      notebookId: 'n1',
      title: '学术课程',
      sourceVersionIds: [],
      slideCount: 2,
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('new-session-job'))?.state).toBe('completed'),
    );
    expect(execute.mock.calls[0][1].options.learnedCapabilities.capsules.length).toBeGreaterThan(0);
    expect(execute.mock.calls[0][1].template).toBeUndefined();
    expect(review).toHaveBeenCalled();
    await port.sendMessage('new-session-job', {
      content: '第2页公式改为x平方',
      requestId: 'revision-1',
      target: { type: 'slide', slideNumber: 2 },
    });
    await vi.waitFor(async () =>
      expect((await port.getJob('new-session-job'))?.messages?.[0]?.status).toBe('applied'),
    );
    const revisedInput = (
      revise.mock.calls.at(-1) as unknown as [
        { options: { contentIntents: { slides: Array<{ formulas: Array<{ latex: string }> }> } } },
      ]
    )[0];
    expect(
      revisedInput.options.contentIntents.slides.map((slide) => slide.formulas[0].latex),
    ).toEqual(['x', 'x^2']);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('does not promote unused template styles or layouts merely because another page passed', async () => {
    const store = new FileCapabilityCapsuleStore(root);
    const learned = await store.learn(scope, visual);
    expect(appliedTemplateCapsuleIds(learned, plan)).toEqual([]);
    const archetype = visual.designProgram.archetypes[0];
    const used = appliedTemplateCapsuleIds(learned, {
      ...plan,
      slides: plan.slides.map((slide) => ({
        ...slide,
        metadata: { visualDirection: { familyId: 'academic', archetypeId: archetype.id } },
      })),
    });
    expect(used).toContain(learned.find((capsule) => capsule.kind === 'style')!.id);
    expect(used).toContain(
      learned.find((capsule) => capsule.source.archetypeId === archetype.id)!.id,
    );
    expect(used).toHaveLength(2);
    expect(
      learned.find((capsule) => capsule.source.archetypeId === archetype.id)?.layout,
    ).toMatchObject({ id: archetype.id });
  });

  it('keeps candidates out of retrieval until verified, survives restart and session changes, and isolates users', async () => {
    const store = new FileCapabilityCapsuleStore(root);
    const learned = await store.learn(scope, visual);
    expect(learned.length).toBeGreaterThan(0);
    expect(await store.search(scope, '学术课程')).toEqual([]);
    await expect(store.compose(scope, [learned[0].id])).rejects.toThrow('verified');
    await store.recordOutcome(scope, {
      jobId: 'job',
      plan,
      capsuleIds: learned.map((c) => c.id),
      result: 'passed',
    });
    const restarted = new FileCapabilityCapsuleStore(root);
    expect(await restarted.search({ ...scope, sessionId: 'second' }, '学术课程')).toContainEqual(
      learned[0],
    );
    expect(await restarted.search({ userId: 'bob', sessionId: 'second' }, '学术课程')).toEqual([]);
    expect(await restarted.load({ userId: 'bob', sessionId: 'second' }, learned[0].id)).toBeNull();
    expect((await restarted.learn(scope, visual)).map((c) => c.id)).toEqual(
      learned.map((c) => c.id),
    );
  });

  it('requires successful quality evidence, isolates failures, and honors explicit rejection across automatic passes', async () => {
    let clock = 0;
    const store = new FileCapabilityCapsuleStore(root, () =>
      new Date(1000 * ++clock).toISOString(),
    );
    const ids = (await store.learn(scope, visual)).map((c) => c.id);
    const failed = {
      ...plan,
      designSpec: { templateVisualReview: { final: { passed: false, issues: [] } } },
    };
    await expect(
      store.recordOutcome(scope, { jobId: 'bad', plan: failed, capsuleIds: ids, result: 'passed' }),
    ).rejects.toThrow();
    await store.recordOutcome(scope, {
      jobId: 'bad',
      plan: failed,
      capsuleIds: ids,
      result: 'failed',
    });
    expect(await store.search(scope, '学术')).toEqual([]);
    await store.recordOutcome(scope, { jobId: 'good', plan, capsuleIds: ids, result: 'passed' });
    await store.recordOutcome(scope, { jobId: 'good', plan, capsuleIds: ids, result: 'rejected' });
    await store.recordOutcome(scope, { jobId: 'other', plan, capsuleIds: ids, result: 'passed' });
    expect(await store.search(scope, '学术')).toEqual([]);
    await store.recordOutcome(scope, { jobId: 'good', plan, capsuleIds: ids, result: 'accepted' });
    expect((await store.search(scope, '学术')).length).toBeGreaterThan(0);
  });

  it('exposes scoped retrieval and composition as ordinary Cordis operations with references', async () => {
    const store = new FileCapabilityCapsuleStore(root);
    const learned = await store.learn(scope, visual);
    await store.recordOutcome(scope, {
      jobId: 'good',
      plan,
      capsuleIds: learned.map((c) => c.id),
      result: 'passed',
    });
    const runtime = new AtomicRuntime([
      { id: 'presentation', version: '1', operations: capabilityMemoryOperations(store) },
    ]);
    try {
      const found = await store.search(scope, '学术课程');
      const result = await runSkillSteps(
        runtime,
        [
          { id: 'find', operation: 'presentation.memory.search', input: { query: '学术课程' } },
          {
            id: 'compose',
            operation: 'presentation.memory.compose',
            input: { ids: [{ $ref: 'find.0.id' }] },
          },
        ],
        { scope },
        (operation) => operation.startsWith('presentation.memory.'),
      );
      expect(result.last).toMatchObject({
        contentBudget: { minBodyFontSize: 24 },
        capsules: [{ id: found[0].id }],
      });
      expect((await runtime.catalog()).map((tool) => tool.name)).toContain(
        'presentation.memory.search',
      );
    } finally {
      await runtime.dispose();
    }
  });
});
