import { expect, it, vi } from 'vitest';

import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import type { TemplateApplication } from './templates';
import { compileTemplateDesignProgram } from './templates/design-program';
import {
  createPresentationVisualStoryboardPlanner,
  presentationStoryboardInputFingerprint,
} from './visual-storyboard';

const scope = { sessionId: 'session', userId: 'user' };
const component = {
  box: { height: 0.3, width: 0.2, x: 0.72, y: 0.62 },
  containsText: false,
  familyId: 'soft',
  id: 'p1-leaf',
  name: 'Watercolor leaf',
  page: 1,
  rationale: 'edge decoration',
  role: 'decoration' as const,
  treatment: 'reuse' as const,
};
const family = {
  artwork: 'soft watercolor wash',
  composition: 'large title at left, artwork anchors the lower-right edge',
  id: 'soft',
  name: 'Soft editorial',
  pages: [1, 2],
  palette: ['#88AACC'],
  preserve: ['paper grain', 'lower-right artwork anchor'],
  typography: 'large restrained sans serif',
};
const designProgram = compileTemplateDesignProgram({
  components: [component],
  families: [family],
  guidance: 'keep the calm watercolor rhythm',
  summary: 'soft watercolor lesson deck',
});
const template: TemplateApplication = {
  constraints: {
    aspectRatio: '16:9',
    fontFamilies: ['Arial'],
    fontSizes: [36],
    palette: ['#88AACC'],
    spacing: {
      horizontalGaps: [0.04],
      margins: { height: 0.08, width: 0.08, x: 0.08, y: 0.08 },
      verticalGaps: [0.04],
    },
  },
  layouts: [
    {
      assetSlots: [],
      elements: [],
      kind: 'image-right',
      layoutId: 'layout-soft',
      referenceSvg: '<svg/>',
      sourceSlideId: 'source-1',
      textCapacity: 160,
    },
  ],
  name: 'Lesson',
  templateId: 'template-1',
  versionId: 'version-1',
  visual: {
    analyzedAt: '2026-09-19T00:00:00.000Z',
    components: [component],
    designProgram,
    families: [family],
    guidance: 'keep the calm watercolor rhythm',
    learning: { guidanceHistory: [], iteration: 1, questions: [], status: 'ready' },
    media: [],
    model: 'vision',
    pages: [{ height: 788, nativeTextCount: 1, page: 1, ref: 'page-1', width: 1400 }],
    schemaVersion: 3,
    summary: 'soft watercolor lesson deck',
    templateId: 'template-1',
    versionId: 'version-1',
  },
};

const jobInput = {
  notebookId: 'studio',
  options: {
    outline: [
      { claim: 'A calm opening', title: 'Opening' },
      { claim: 'One clear lesson', title: 'Lesson' },
    ],
  },
  slideCount: 2,
  sourceVersionIds: [] as string[],
  title: 'Course',
};

const response = (componentIds: string[]) => ({
  deckRationale: 'Open with calm space, then increase information density.',
  inputFingerprint: presentationStoryboardInputFingerprint(jobInput),
  rhythm: ['cover breathes', 'content keeps the lower-right anchor'],
  schemaVersion: 1 as const,
  slides: [
    {
      archetypeId: 'archetype-soft',
      assetMode: 'reuse' as const,
      componentIds,
      compositionIntent: 'Title at left with the watercolor leaf balancing the lower-right.',
      continuity: 'Carry the paper grain into the next page.',
      familyId: 'soft',
      layoutId: 'layout-soft',
      role: 'cover' as const,
      slideId: 'slide-1',
    },
    {
      archetypeId: 'archetype-soft',
      assetMode: 'none' as const,
      componentIds: [],
      compositionIntent: 'Use the same anchors with denser editable content.',
      continuity: 'Repeat the lower-right direction without repeating the exact leaf.',
      familyId: 'soft',
      layoutId: 'layout-soft',
      role: 'content' as const,
      slideId: 'slide-2',
    },
  ],
  templateId: 'template-1',
  versionId: 'version-1',
});

const chatPort = (
  componentIds: string[],
  extras?: Record<string, unknown>,
  slideOverrides?: Record<string, unknown>,
): GLMMultimodalChatPort => ({
  chat: vi.fn(async () => ({
    choices: [
      {
        index: 0,
        message: {
          content: JSON.stringify({
            ...response(componentIds),
            ...extras,
            ...(slideOverrides
              ? {
                  slides: response(componentIds).slides.map((slide) => ({
                    ...slide,
                    ...slideOverrides,
                  })),
                }
              : {}),
          }),
          role: 'assistant' as const,
        },
      },
    ],
    created: 1,
    id: 'storyboard',
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
});

it('accepts the contract/binding envelope the prompt documents', async () => {
  const payload = response([]);
  const chat: GLMMultimodalChatPort = {
    ...chatPort([]),
    chat: vi.fn(async () => ({
      choices: [
        {
          index: 0,
          message: {
            content: JSON.stringify({
              binding: {
                inputFingerprint: payload.inputFingerprint,
                templateId: 'template-1',
                versionId: 'version-1',
              },
              contract: payload,
            }),
            role: 'assistant' as const,
          },
        },
      ],
      created: 1,
      id: 'storyboard',
      model: 'vision',
    })),
  };
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput, template },
    { scope },
  );
  expect(storyboard.slides).toHaveLength(2);
  expect(storyboard.deckRationale).toBe(payload.deckRationale);
  expect(storyboard.templateId).toBe('template-1');
  expect(storyboard.inputFingerprint).toBe(payload.inputFingerprint);
});

it('keeps Image enabled on a scientific page with mixed per-block requirements', async () => {
  const mixedInput = {
    ...jobInput,
    options: {
      ...jobInput.options,
      contentIntents: {
        inputFingerprint: 'mixed-v2',
        slides: [1, 2].map((page) => ({
          slideId: `slide-${page}`,
          claim: 'Hybrid',
          formulas: [],
          visualKind: 'scientific-diagram',
          visualReason: 'Precise curve and illustration',
          visuals: [
            { id: 'curve', kind: 'chart', brief: 'Precise curve', required: true },
            {
              id: 'anatomy',
              kind: 'scientific-illustration',
              brief: 'Clear brain structure',
              required: true,
            },
          ],
        })),
      },
    },
  };
  const chat = chatPort([], {
    inputFingerprint: presentationStoryboardInputFingerprint(mixedInput),
  });
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput: mixedInput, template },
    { scope },
  );
  expect(storyboard.slides.every((s) => s.assetMode === 'mixed')).toBe(true);
  expect(storyboard.slides[0].assetBrief).toContain('anatomy');
});

it('resolves a family-local archetype alias without weakening family or component safety', async () => {
  const chat = chatPort(['leaf'], undefined, { archetypeId: 'soft', layoutId: 'invented' });
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput, template },
    { scope },
  );

  expect(storyboard.slides[0]).toMatchObject({
    archetypeId: 'archetype-soft',
    componentIds: ['p1-leaf'],
    familyId: 'soft',
  });
  expect(vi.mocked(chat.chat).mock.calls[0][0].messages[0].content).toContain(
    'assetMode 必须是 generate',
  );
  expect(storyboard.slides[0].layoutId).toBeUndefined();
});

it('ignores harmless echoed input fields and bounds verbose prose at the model boundary', async () => {
  const verbose = '保持柔和水彩、纸张肌理和充足留白。'.repeat(200);
  const chat = chatPort(['p1-leaf'], {
    designProgram,
    deckRationale: verbose,
    rhythm: [{ beat: 'opening', direction: verbose }],
    title: 'Echoed input title',
  });
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput, template },
    { scope },
  );

  expect(storyboard.deckRationale.length).toBeLessThanOrEqual(2400);
  expect(storyboard.rhythm[0]).toContain('opening');
  expect(storyboard.rhythm[0].length).toBeLessThanOrEqual(500);
  expect(storyboard).not.toHaveProperty('title');
  expect(storyboard).not.toHaveProperty('designProgram');
  expect(chat.chat).toHaveBeenCalledTimes(1);
});

it('maps the complete outline to template archetypes before slide composition', async () => {
  const chat = chatPort(['p1-leaf']);
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    {
      jobInput,
      template,
    },
    { scope },
  );
  expect(storyboard.slides.map(({ role }) => role)).toEqual(['cover', 'content']);
  expect(storyboard.slides[0].componentIds).toEqual(['p1-leaf']);
  expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0].messages)).toContain(
    'lower-right artwork anchor',
  );
});

it.each(['', '  \n ', null])(
  'omits empty optional prose on native pages without repeating planning (%j)',
  async (empty) => {
    const chat = chatPort([], undefined, {
      assetMode: 'native',
      assetBrief: empty,
      layoutId: empty,
    });
    const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
      { jobInput, template },
      { scope },
    );
    expect(storyboard.slides).toHaveLength(2);
    expect(
      storyboard.slides.every(
        (slide) => slide.assetBrief === undefined && slide.layoutId === undefined,
      ),
    ).toBe(true);
    expect(chat.chat).toHaveBeenCalledOnce();
  },
);

it('still requires an actual artwork brief for generated subjects', async () => {
  const chat = chatPort([], undefined, { assetMode: 'generate', assetBrief: ' ' });
  await expect(
    createPresentationVisualStoryboardPlanner({ chat }).plan({ jobInput, template }, { scope }),
  ).rejects.toThrow('第 1 页需要生成素材');
  expect(chat.chat).toHaveBeenCalledTimes(2);
});

it('keeps the brief for a generated page while accepting a native page without artwork', async () => {
  const original = response([]);
  const chat = chatPort([], {
    slides: original.slides.map((slide, index) => ({
      ...slide,
      assetMode: index === 0 ? 'generate' : 'native',
      assetBrief: index === 0 ? '  A new coral paper plane with room for editable text.  ' : '',
    })),
  });
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput, template },
    { scope },
  );
  expect(storyboard.slides[0].assetBrief).toBe(
    'A new coral paper plane with room for editable text.',
  );
  expect(storyboard.slides[1].assetBrief).toBeUndefined();
  expect(chat.chat).toHaveBeenCalledOnce();
});

it('binds omitted identity and protocol metadata from the trusted job and template', async () => {
  const chat = chatPort([], {
    templateId: undefined,
    versionId: undefined,
    inputFingerprint: undefined,
    schemaVersion: undefined,
  });
  const storyboard = await createPresentationVisualStoryboardPlanner({ chat }).plan(
    { jobInput, template },
    { scope },
  );
  expect(storyboard).toMatchObject({
    templateId: template.templateId,
    versionId: template.versionId,
    inputFingerprint: presentationStoryboardInputFingerprint(jobInput),
    schemaVersion: 1,
  });
  expect(chat.chat).toHaveBeenCalledOnce();
});

it.each([
  { templateId: 'another-template' },
  { versionId: 'another-version' },
  { inputFingerprint: 'a'.repeat(40) },
])('rejects a conflicting model-supplied binding: %j', async (binding) => {
  const chat = chatPort([], binding);
  await expect(
    createPresentationVisualStoryboardPlanner({ chat }).plan({ jobInput, template }, { scope }),
  ).rejects.toThrow('must stay bound');
});

it('refuses baked or unknown components instead of letting the model invent reusable assets', async () => {
  const chat = chatPort(['unknown-decoration']);
  await expect(
    createPresentationVisualStoryboardPlanner({ chat }).plan(
      {
        jobInput,
        template,
      },
      { scope },
    ),
  ).rejects.toThrow('unsafe template component');
  expect(chat.chat).toHaveBeenCalledTimes(2);
});
