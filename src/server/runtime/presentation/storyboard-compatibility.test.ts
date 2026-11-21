import { describe, expect, it, vi } from 'vitest';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { CapabilityCapsule, CapabilityMemory } from './capability-memory';
import type { StoredPresentationJob } from './file-storage';
import type { PresentationGenerationCapability } from './generation-capability';
import { PresentationGenerationPort } from './generation-port';
import type { MultimodalChatPort } from './multimodal-chat-provider';
import { createDeckVisualSystem } from './deck-visual-system';
import { checkStoryboardCompatibility, storyboardPageCapsules } from './storyboard-compatibility';

const scope = { userId: 'u1', sessionId: 's1', request: new Request('https://example.test') };
const style = (id: string, flat: boolean) =>
  ({
    id,
    kind: 'style',
    designReference: { style: { id, flat } },
    source: { evidencePages: [1] },
  }) as CapabilityCapsule;
const layout = (id: string, lanes: { kind: string; width: number; height: number }[]) =>
  ({
    id,
    kind: 'layout',
    layout: { roles: ['content'] },
    source: { aspectRatio: '16:9', evidencePages: [1] },
    designReference: {
      slots: [
        {
          id: 'title',
          kind: 'title',
          fontSize: 32,
          box: { x: 0.05, y: 0.06, width: 0.9, height: 0.15 },
        },
        ...lanes.map((lane, i) => ({
          id: 'lane-' + i,
          kind: lane.kind,
          box: { x: 0.05 + i * 0.42, y: 0.24, width: lane.width, height: lane.height },
        })),
      ],
    },
  }) as CapabilityCapsule;
const original = [
  style('cut-paper', false),
  layout('picture-only', [{ kind: 'picture', width: 0.82, height: 0.6 }]),
];
const replacement = [
  style('flat-grid', true),
  layout('two-lanes', [
    { kind: 'object', width: 0.4, height: 0.62 },
    { kind: 'object', width: 0.4, height: 0.62 },
  ]),
];
const input: PresentationJobInput = {
  notebookId: 'studio',
  sourceVersionIds: [],
  title: '复杂校核',
  slideCount: 2,
  options: {
    style: '白底学术',
    capabilityIds: original.map(({ id }) => id),
    outline: [{ title: '封面' }, { title: '用图片、公式与数据表校核' }],
    contentIntents: {
      slides: [
        {
          slideId: 'slide-1',
          claim: '全稿主题',
          formulas: [],
          visualKind: 'none',
          visualReason: '标题页',
        },
        {
          slideId: 'slide-2',
          claim: '计算结果',
          formulas: [{ id: 'formula', latex: String.raw`T=\frac{S-D}{R-D}` }],
          visualKind: 'source-figure',
          visualReason: '来源图',
          visuals: [
            {
              id: 'figure',
              kind: 'source-figure',
              renderer: 'image',
              brief: '来源原图',
              required: true,
            },
            { id: 'table', kind: 'chart', renderer: 'native', brief: '四列表格', required: true },
          ],
        },
      ],
    },
    generatedImageSlots: [
      {
        slideId: 'slide-2',
        slotId: 'figure',
        state: 'ready',
        assetRefs: [{ ref: 'existing-owned-figure' }],
      },
    ],
  },
};

describe('storyboard compatibility coordination', () => {
  it('reserves native table cells and the sequence of node slots before generic exhibit lanes', async () => {
    const generic = layout('generic', [{ kind: 'object', width: 0.85, height: 0.6 }]);
    const table = layout('table', [{ kind: 'table', width: 0.6, height: 0.6 }]);
    const flow = layout(
      'flow',
      Array.from({ length: 2 }, () => ({
        kind: 'object',
        width: 0.19,
        height: 0.5,
      })),
    );
    flow.layout!.roles = ['process'];
    const capsules = [style('flat', true), generic, table, flow];
    const source: PresentationJobInput = {
      ...input,
      options: {
        outline: [{ title: '值班安排' }, { title: '复核流程' }],
        deckVisualSystem: createDeckVisualSystem(input),
        contentIntents: {
          slides: [
            {
              slideId: 'table',
              claim: '每周轮值',
              formulas: [],
              visualKind: 'chart',
              visualReason: '列头为周次与日期，单元格可编辑',
            },
            {
              slideId: 'flow',
              claim: '流程图',
              formulas: [],
              visualKind: 'scientific-diagram',
              visualReason: '四个节点以箭头连接，第二步先查看排班表',
            },
          ],
        },
      },
    };
    const report = await checkStoryboardCompatibility(source, capsules, []);
    expect(report?.pages.map((page) => [page.requirements[0].kind, page.layoutIds[0]])).toEqual([
      ['table', 'table'],
      ['graph', 'flow'],
    ]);
    const saved = {
      schemaVersion: 1,
      pages: [
        { slideId: 'table', layoutIds: ['generic'], requirements: [{ kind: 'chart' }] },
        { slideId: 'flow', layoutIds: ['generic'], requirements: [{ kind: 'object' }] },
      ],
    };
    for (const [slideId, blockType, expected] of [
      ['table', 'table', 'table'],
      ['flow', 'graph', 'flow'],
    ]) {
      const before = JSON.stringify(saved);
      expect(
        storyboardPageCapsules(saved, slideId, capsules, [
          { kind: 'scientific-diagram', spec: { type: blockType } },
        ]).map(({ id }) => id),
      ).toEqual(['flat', 'generic', expected]);
      expect(JSON.stringify(saved)).toBe(before);
    }
  });

  it.each([true, false])(
    'checks owned alternatives before GPT or paid work (alternative fits: %s)',
    async (fits) => {
      let saved: StoredPresentationJob | undefined;
      const choices = fits ? replacement : replacement.slice(0, 1);
      const candidates = vi.fn(async () => choices);
      const compose = vi.fn(async (_scope, ids: string[]) => ({
        capsules: ids.map((id) => [...original, ...choices].find((capsule) => capsule.id === id)!),
      }));
      const memory = {
        candidates,
        compose,
        learnRecipes: vi.fn(async () => []),
        recordOutcome: vi.fn(),
      } as unknown as CapabilityMemory;
      const chat = vi.fn(async () => ({
        created: 1,
        id: 'diagnosis-result',
        model: 'gpt-diagnostic-fixture',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                reason: '没有原生对象槽位',
                repairInstruction: '增加有标准原生对象槽位的版式',
              }),
            },
          },
        ],
      }));
      const execute = vi.fn<PresentationGenerationCapability['execute']>(
        async (_scope, received) => {
          const caps = (received.options?.learnedCapabilities as { capsules: CapabilityCapsule[] })
            .capsules;
          const selected = storyboardPageCapsules(
            received.options?.layoutCompatibility,
            'slide-2',
            caps,
          );
          expect(selected.map(({ id }) => id)).toEqual(['flat-grid', 'two-lanes']);
          expect(received.options?.generatedImageSlots).toEqual(input.options?.generatedImageSlots);
          expect(saved?.stageHandoffs?.['compatibility:deck']?.schemaVersion).toBe(1);
          return { artifacts: [] } as never;
        },
      );
      const port = new PresentationGenerationPort(
        {
          artifactStore: new InMemoryPresentationArtifactStore(),
          capability: { execute } as unknown as PresentationGenerationCapability,
          capabilityMemory: memory,
          layoutDiagnosisChat: {
            chat,
            manifest: { model: 'gpt-diagnostic-fixture' },
          } as unknown as MultimodalChatPort,
          contextFactory: () => ({
            plannerContext: {},
            workerContext: {
              jobId: 'unused',
              convert: vi.fn(),
              qualityCheck: vi.fn(),
              workspace: { path: '/tmp', write: vi.fn() },
            },
          }),
          repository: {
            getJob: async () => saved ?? null,
            saveJob: async (_scope, s) => {
              saved = structuredClone(s);
            },
          },
        },
        scope,
      );
      try {
        await port.createJob(input);
        await vi.waitFor(() => expect(saved?.job.state).toBe(fits ? 'completed' : 'failed'));
        expect(candidates).toHaveBeenCalledOnce();
        const report = saved?.input.options?.layoutCompatibility;
        expect(report).toMatchObject({ previousStyleId: 'cut-paper', styleId: 'flat-grid' });
        if (fits) {
          expect(execute).toHaveBeenCalledOnce();
          expect(chat).not.toHaveBeenCalled();
        } else {
          expect(execute).not.toHaveBeenCalled();
          expect(chat).toHaveBeenCalledOnce();
          expect(saved?.job.error?.message).toContain('没有原生对象槽位');
          expect(saved?.stageHandoffs?.['diagnosis:storyboard']).toMatchObject({
            stage: 'diagnosis',
            schemaVersion: 1,
          });
        }
      } finally {
        await port.dispose();
      }
    },
  );
});

it('diagnoses only the exhausted page, keeps the image ref and reviews the full deck before export', async () => {
  const imageRef = 'owned-filter-image';
  const svg = (text: string, image = false) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="45" y="60" font-size="32">${text}</text>${image ? `<image x="480" y="120" width="384" height="216" href="/api/runtime/presentation/artifacts/${imageRef}"/>` : ''}</svg>`;
  const cover = { slideId: 'slide-1', order: 1, svg: svg('封面'), notes: '保留讲稿' };
  const originalPage = {
    slideId: 'slide-2',
    order: 2,
    svg: svg('数据页', true),
    notes: '保留读数',
  };
  const initial = {
    planId: 'input',
    title: '校核',
    sourceVersionIds: [],
    aspectRatio: '16:9',
    designSpec: { contentPolicyVersion: 1 },
    slides: [cover, originalPage],
  };
  const repairedPage = { ...originalPage, svg: originalPage.svg.replace('y="120"', 'y="148"') };
  const store = new InMemoryPresentationArtifactStore();
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 16, height: 9, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  await store.put(scope, {
    artifactId: imageRef,
    bytes,
    type: 'image',
    mimeType: 'image/png',
    name: 'filter.png',
  });
  const chat = vi.fn(async () => ({
    created: 1,
    id: 'diagnostic',
    model: 'gpt-diagnostic-fixture',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            reason: '表格和图片分区不足',
            repairInstruction: '调整图片位置，保留其引用',
          }),
        },
      },
    ],
  }));
  const firstIssue = {
    slideId: 'slide-2',
    category: 'composition' as const,
    severity: 'major' as const,
    evidence: 'Learned layout compilation failed: media-content-exceeds-source-capacity',
    instruction: 'Reflow the same assets',
  };
  const review = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: 1,
      passed: false,
      issues: [firstIssue],
      summary: '第 2 页版式失败',
    })
    .mockImplementationOnce(async ({ plan }) => {
      expect(plan.slides).toEqual([cover, repairedPage]);
      return { schemaVersion: 1, passed: true, issues: [], summary: '整稿通过' };
    });
  const plan = vi.fn(async () => ({
    ...initial,
    slides: [{ ...cover, svg: svg('误改的封面') }, repairedPage],
  }));
  const execute = vi.fn<PresentationGenerationCapability['execute']>(
    async (_scope, _input, ctx) => {
      const final = await ctx.preparePlan!(initial);
      expect(final.slides[1].svg).toContain('data:image/png;base64,');
      expect(final.slides[0]).toEqual(cover);
      return { artifacts: [] } as never;
    },
  );
  let saved: StoredPresentationJob | undefined;
  const port = new PresentationGenerationPort(
    {
      artifactStore: store,
      capability: { execute, plan } as unknown as PresentationGenerationCapability,
      contextFactory: () => ({
        plannerContext: {},
        workerContext: {
          jobId: 'fixture',
          convert: vi.fn(),
          qualityCheck: vi.fn(),
          workspace: { path: '/tmp', write: vi.fn() },
        },
      }),
      repository: {
        getJob: async () => saved ?? null,
        saveJob: async (_scope, s) => {
          saved = structuredClone(s);
        },
      },
      visualCritic: { review },
      layoutDiagnosisChat: {
        chat,
        manifest: { model: 'gpt-diagnostic-fixture' },
      } as unknown as MultimodalChatPort,
    },
    scope,
  );
  try {
    const job = await port.createJob({
      notebookId: 'fixture',
      title: '校核',
      sourceVersionIds: [],
      slideCount: 2,
    });
    await vi.waitFor(async () => expect((await port.getJob(job.jobId))?.state).toBe('completed'));
    expect(chat).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({
        revision: expect.objectContaining({
          target: { type: 'slide', slideNumber: 2 },
          content: expect.stringContaining('调整图片位置'),
        }),
      }),
    );
    expect(review).toHaveBeenCalledTimes(2);
    expect(saved?.plan?.slides).toEqual([cover, repairedPage]);
    expect(saved?.stageHandoffs?.['diagnosis:slide-2']).toMatchObject({ stage: 'diagnosis' });
  } finally {
    await port.dispose();
  }
});
