import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import { createDeckVisualSystem, renderDeckVisualFrame } from './deck-visual-system';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import type { TemplateApplication } from './templates';
import { compileTemplateDesignProgram } from './templates/design-program';
import {
  adjudicateVisualReviewStatus,
  createPresentationVisualCritic,
  type PresentationVisualReview,
  retainUnresolvedVisualIssues,
  retryTransientVisualReview,
} from './visual-critic';

it('derives the publish gate from validated severities without waiving major defects', () => {
  const review: PresentationVisualReview = {
    schemaVersion: 1,
    passed: false,
    summary: 'A spacing suggestion',
    issues: [
      {
        slideId: 'slide-1',
        severity: 'minor',
        category: 'spacing',
        evidence: 'Small margin difference',
        instruction: 'Optional margin adjustment',
      },
    ],
  };
  expect(adjudicateVisualReviewStatus(review).passed).toBe(true);
  expect(
    adjudicateVisualReviewStatus({
      ...review,
      passed: true,
      issues: [{ ...review.issues[0], severity: 'major' }],
    }).passed,
  ).toBe(false);
  expect(() => adjudicateVisualReviewStatus({ ...review, issues: [] })).toThrow('blocking issues');
});

it('retries transient visual-review HTTP 500 without retrying malformed content', async () => {
  const temporary = Object.assign(new Error('Multimodal chat provider returned HTTP 500'), {
    code: 'CHAT_UNAVAILABLE',
  });
  const request = vi
    .fn()
    .mockRejectedValueOnce(temporary)
    .mockRejectedValueOnce(temporary)
    .mockResolvedValue('reviewed');
  await expect(retryTransientVisualReview(request)).resolves.toBe('reviewed');
  expect(request).toHaveBeenCalledTimes(3);
  const invalid = vi.fn().mockRejectedValue(
    Object.assign(new Error('Invalid review JSON'), {
      code: 'CHAT_UNAVAILABLE',
    }),
  );
  await expect(retryTransientVisualReview(invalid)).rejects.toThrow('Invalid review JSON');
  expect(invalid).toHaveBeenCalledTimes(1);
});

it('does not forget a confirmed unresolved defect when a subsequent review omits it', () => {
  const previous: PresentationVisualReview = {
    schemaVersion: 1,
    passed: false,
    summary: 'Tangency is incorrect',
    issues: [
      {
        slideId: 'slide-6',
        visualId: 'kkt',
        category: 'scientific-semantics',
        severity: 'major',
        evidence: 'Curves intersect instead of touching',
        instruction: 'Use a tangent line and opposite normal vectors',
      },
    ],
  };
  const current: PresentationVisualReview = {
    schemaVersion: 1,
    passed: true,
    summary: 'No new issues',
    issues: [],
  };
  expect(retainUnresolvedVisualIssues(current, previous)).toMatchObject({
    passed: false,
    issues: previous.issues,
  });
  expect(retainUnresolvedVisualIssues(current)).toBe(current);
  expect(retainUnresolvedVisualIssues(current, { ...previous, passed: true, issues: [] })).toBe(
    current,
  );
});

const scope = { sessionId: 'session', userId: 'user' };

it('reviews one whole-deck contact sheet after the detailed page batches', async () => {
  const system = createDeckVisualSystem({
    notebookId: 'test',
    title: '统一工作汇报',
    sourceVersionIds: [],
    options: { style: '商务' },
  })!;
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            schemaVersion: 1,
            passed: true,
            summary: '统一视觉系统通过',
            issues: [],
          }),
        },
      },
    ],
    created: 1,
    id: 'review',
    model: 'test',
  }));
  const port: GLMMultimodalChatPort = {
    chat,
    providerId: 'test',
    manifest: {
      model: 'test',
      providerId: 'test',
      displayName: 'test',
      supportsVision: true,
      supportsIdempotency: true,
    },
  };
  const slides = Array.from({ length: 5 }, (_, index) => ({
    slideId: `slide-${index + 1}`,
    order: index + 1,
    svg: renderDeckVisualFrame(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><g data-deck-body="true"><text x="60" y="180" font-size="24">已验证内容</text></g></svg>',
      system,
      { title: `标题${index + 1}`, role: 'content', order: index + 1, total: 5 },
    ),
  }));
  const review = await createPresentationVisualCritic({
    chat: port,
    store: new InMemoryPresentationArtifactStore(),
  }).review(
    {
      plan: {
        planId: 'deck',
        title: '工作汇报',
        aspectRatio: '16:9',
        sourceVersionIds: [],
        designSpec: { deckVisualSystem: system },
        slides,
      },
    },
    { scope },
  );
  expect(review.passed).toBe(true);
  expect(chat).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(chat.mock.calls.at(-1)?.[0].messages[0].content)).toContain(
    '检查整份演示的统一视觉系统',
  );
});
const family = {
  artwork: 'watercolor',
  composition: 'left title, right art',
  id: 'soft',
  name: 'Soft',
  pages: [1],
  palette: ['#88AACC'],
  preserve: ['open center'],
  typography: 'large title',
};
const designProgram = compileTemplateDesignProgram({
  components: [],
  families: [family],
  guidance: 'preserve open center',
  summary: 'soft deck',
});
const template: TemplateApplication = {
  constraints: {
    aspectRatio: '16:9',
    fontFamilies: [],
    fontSizes: [],
    palette: ['#88AACC'],
    spacing: { horizontalGaps: [], margins: { height: 0, width: 0, x: 0, y: 0 }, verticalGaps: [] },
  },
  layouts: [],
  name: 'Soft',
  templateId: 'template',
  versionId: 'version',
  visual: {
    analyzedAt: '2026-09-19T00:00:00.000Z',
    components: [],
    designProgram,
    families: [family],
    guidance: 'preserve open center',
    learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
    media: [],
    model: 'vision',
    pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'template-page', width: 1400 }],
    schemaVersion: 3,
    summary: 'soft deck',
    templateId: 'template',
    versionId: 'version',
  },
};

it.each([true, false])(
  'reviews every page in bounded batches and catches a late scientific diagram defect (template=%s)',
  async (withTemplate) => {
    const store = new InMemoryPresentationArtifactStore();
    const observed: string[] = [];
    const chat: GLMMultimodalChatPort = {
      manifest: {
        displayName: 'Vision',
        model: 'vision',
        providerId: 'vision',
        supportsVision: true,
        supportsIdempotency: true,
      },
      providerId: 'vision',
      chat: vi.fn(async (request, context) => {
        expect(context.trustedImages!.urls.length).toBeLessThanOrEqual(6);
        const text = JSON.stringify(request.messages);
        const ids = [...text.matchAll(/待复核成品：(slide-\d+)/gu)].map((match) => match[1]);
        observed.push(...ids);
        const issues = ids.includes('slide-7')
          ? [
              {
                slideId: 'slide-7',
                category: 'scientific-semantics',
                severity: 'major',
                evidence: '箭头方向与说明相反',
                instruction: '修正结构化边方向',
              },
            ]
          : [];
        return {
          id: 'review',
          created: 1,
          model: 'vision',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant' as const,
                content: JSON.stringify({
                  schemaVersion: 1,
                  passed: !issues.length,
                  issues,
                  summary: '逐页复核',
                }),
              },
            },
          ],
        };
      }),
    };
    const result = await createPresentationVisualCritic({ chat, store }).review(
      {
        ...(withTemplate ? { template } : {}),
        plan: {
          planId: 'all-pages',
          title: 'Deck',
          aspectRatio: '16:9',
          sourceVersionIds: [],
          slides: Array.from({ length: 9 }, (_, index) => ({
            order: index + 1,
            slideId: `slide-${index + 1}`,
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text font-size="32" x="40" y="70">Scientific content</text></svg>',
          })),
        },
      },
      { scope },
    );
    expect(observed).toEqual(Array.from({ length: 9 }, (_, index) => `slide-${index + 1}`));
    expect(result.passed).toBe(false);
    expect(result.issues[0].slideId).toBe('slide-7');
    expect(chat.chat).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  'reviews owned template pixels even with a shared master (%s)',
  async (sharedMaster) => {
    const store = new InMemoryPresentationArtifactStore();
    const reference = await sharp({
      create: { background: '#88AACC', channels: 3, height: 90, width: 160 },
    })
      .jpeg()
      .toBuffer();
    await store.put(scope, {
      artifactId: 'template-page',
      bytes: reference,
      mimeType: 'image/jpeg',
      name: 'reference.jpg',
      type: 'image',
    });
    const review = {
      issues: [
        {
          category: 'spacing',
          evidence: 'The title touches the left edge while the reference keeps a broad margin.',
          instruction: 'Move the title right and keep the illustration anchor unchanged.',
          severity: 'major',
          slideId: 'slide-1',
        },
      ],
      passed: false,
      schemaVersion: 1,
      summary: 'The hierarchy is sound but the left margin is too tight.',
    };
    const chat: GLMMultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: { content: JSON.stringify(review), role: 'assistant' as const },
          },
        ],
        created: 1,
        id: 'review',
        model: 'vision',
      })),
      manifest: {
        displayName: 'Vision',
        model: 'vision',
        providerId: 'vision',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'vision',
    };
    const result = await createPresentationVisualCritic({ chat, store }).review(
      {
        plan: {
          aspectRatio: '16:9',
          planId: 'plan',
          ...(sharedMaster
            ? {
                designSpec: {
                  deckVisualSystem: createDeckVisualSystem({
                    notebookId: 'test',
                    title: 'Deck',
                    sourceVersionIds: [],
                    options: { style: 'business' },
                  }),
                },
              }
            : {}),
          slides: [
            {
              order: 1,
              slideId: 'slide-1',
              svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/><text x="2" y="80">Title</text></svg>',
            },
          ],
          sourceVersionIds: [],
          title: 'Deck',
        },
        template,
      },
      { scope },
    );
    expect(result).toEqual(review);
    const [, context] = vi.mocked(chat.chat).mock.calls[0];
    expect(context.trustedImages?.urls).toHaveLength(2);
    const message = vi.mocked(chat.chat).mock.calls[0][0].messages[1].content;
    if (!Array.isArray(message)) throw new Error('Expected multimodal review context');
    const payload = JSON.parse(message.find((part) => part.type === 'text')!.text!);
    expect(payload.currentTask.title).toBe('Deck');
    if (sharedMaster) {
      expect(payload.designProgram).toBeUndefined();
      expect(payload.referenceStructures).toHaveLength(designProgram.archetypes.length);
      expect(payload.deckPolicy).toContain('当前任务事实 > deckVisualSystem');
    } else {
      expect(payload.designProgram).toEqual(designProgram);
    }
    expect(
      Array.isArray(message) && message.filter((part) => part.type === 'image_url'),
    ).toHaveLength(2);
  },
);

it('projects verbose critic output onto the trusted review contract', async () => {
  const store = new InMemoryPresentationArtifactStore();
  const reference = await sharp({
    create: { background: '#88AACC', channels: 3, height: 90, width: 160 },
  })
    .jpeg()
    .toBuffer();
  await store.put(scope, {
    artifactId: 'template-page',
    bytes: reference,
    mimeType: 'image/jpeg',
    name: 'reference.jpg',
    type: 'image',
  });
  const chat: GLMMultimodalChatPort = {
    chat: vi.fn(async () => ({
      choices: [
        {
          index: 0,
          message: {
            content: JSON.stringify({
              commentary: 'not part of the contract',
              issues: [
                {
                  category: 'template_fidelity',
                  evidence: { observation: 'The illustration anchor drifted.' },
                  instruction: { repair: 'Restore the original right-hand anchor.' },
                  severity: 'high',
                  slideId: 'slide-1',
                  thought: 'discard me',
                },
              ],
              passed: false,
              schemaVersion: '1',
              summary: { verdict: 'One bounded repair is needed.' },
            }),
            role: 'assistant' as const,
          },
        },
      ],
      created: 1,
      id: 'review-normalized',
      model: 'vision',
    })),
    manifest: {
      displayName: 'Vision',
      model: 'vision',
      providerId: 'vision',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'vision',
  };
  const result = await createPresentationVisualCritic({ chat, store }).review(
    {
      plan: {
        aspectRatio: '16:9',
        planId: 'plan',
        slides: [
          {
            order: 1,
            slideId: 'slide-1',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/></svg>',
          },
        ],
        sourceVersionIds: [],
        title: 'Deck',
      },
      template,
    },
    { scope },
  );

  expect(result).toEqual({
    issues: [
      {
        category: 'template-fidelity',
        evidence: '{"observation":"The illustration anchor drifted."}',
        instruction: '{"repair":"Restore the original right-hand anchor."}',
        severity: 'major',
        slideId: 'slide-1',
      },
    ],
    passed: false,
    schemaVersion: 1,
    summary: '{"verdict":"One bounded repair is needed."}',
  });
});

it('compares artwork against its own family evidence and accepts a targeted cutout repair', async () => {
  const store = new InMemoryPresentationArtifactStore();
  const reference = await sharp({
    create: { width: 160, height: 90, channels: 3, background: '#88AACC' },
  })
    .png()
    .toBuffer();
  await store.put(scope, {
    artifactId: 'middle-reference',
    bytes: reference,
    mimeType: 'image/png',
    name: 'middle.png',
    type: 'image',
  });
  const get = vi.spyOn(store, 'get');
  const chat: GLMMultimodalChatPort = {
    providerId: 'vision',
    manifest: {
      displayName: 'Vision',
      providerId: 'vision',
      model: 'vision',
      supportsIdempotency: true,
      supportsVision: true,
    },
    chat: vi.fn(async () => ({
      id: 'review',
      model: 'vision',
      created: 1,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({
              schemaVersion: 1,
              passed: false,
              summary: 'Cutout has a white fringe',
              issues: [
                {
                  category: 'cutout',
                  severity: 'major',
                  slideId: 'body',
                  evidence: 'White fringe around the subject',
                  instruction:
                    'Remove only the white fringe while preserving the watercolor brushwork',
                },
              ],
            }),
          },
        },
      ],
    })),
  };
  const result = await createPresentationVisualCritic({ chat, store }).review(
    {
      template: {
        ...template,
        visual: {
          ...template.visual!,
          families: [{ ...family, pages: [2] }],
          pages: [
            { page: 1, ref: 'unrelated-cover', width: 1400, height: 788, nativeTextCount: 0 },
            { page: 2, ref: 'middle-reference', width: 1400, height: 788, nativeTextCount: 0 },
            { page: 3, ref: 'unrelated-closing', width: 1400, height: 788, nativeTextCount: 0 },
          ],
        },
      },
      plan: {
        planId: 'family-plan',
        aspectRatio: '16:9',
        title: 'Body',
        sourceVersionIds: [],
        slides: [
          {
            order: 1,
            slideId: 'body',
            metadata: { visualDirection: { familyId: 'soft' } },
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/></svg>',
          },
        ],
      },
    },
    { scope },
  );
  expect(result.issues[0].category).toBe('cutout');
  expect(get).toHaveBeenCalledWith(scope, 'middle-reference');
  expect(get).not.toHaveBeenCalledWith(scope, 'unrelated-cover');
  expect(get).not.toHaveBeenCalledWith(scope, 'unrelated-closing');
});
