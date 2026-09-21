import { describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationPort,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import { ImageGenerationEventPublisher, InMemoryImageGenerationEventJournal } from './asset-events';
import { InMemoryPresentationAssetStore } from './asset-store';
import { createImageGenerationCapability } from './image-generation-capability';
import type { GLMChatResult, GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import {
  boundPresentationPromptText,
  createRevisionAssetPlanner,
  parseAssetIntentPayload,
  type PresentationRevisionAssetInput,
  type RevisionAssetIntent,
} from './revision-assets';

const scope = { sessionId: 'session-1', userId: 'user-1' };
const svg = (text: string, image = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="32" y="100">${text}</text>${image}</svg>`;
const oldImage =
  '<image href="/api/runtime/presentation/artifacts/old-image" x="500" y="140" width="400" height="300"/>';
const basePlan: PresentationPlan = {
  aspectRatio: '16:9',
  planId: 'base-version',
  slides: [
    { order: 1, slideId: 'cover', svg: svg('Cover') },
    { order: 2, slideId: 'product', svg: svg('Product', oldImage) },
    { order: 3, slideId: 'summary', svg: svg('Summary') },
  ],
  sourceVersionIds: [],
  title: 'Product',
};
const input: PresentationRevisionAssetInput = {
  basePlan,
  jobId: 'job-1',
  jobInput: { notebookId: 'notebook', slideCount: 3, sourceVersionIds: [], title: 'Product' },
  revision: {
    content: 'Use a new photo of the product on the right and move its description to the left.',
    requestId: 'edit-1',
    target: { slideNumber: 2, type: 'slide' },
  },
  scope,
};
const replaceIntent: RevisionAssetIntent = {
  action: 'replace',
  layout: { fit: 'contain', height: 0.6, width: 0.42, x: 0.53, y: 0.25 },
  prompt: 'Studio photograph of a minimalist teal portable speaker, white background, no text.',
  ref: '/api/runtime/presentation/artifacts/old-image',
  size: '1024x1536',
  slideId: 'product',
  slotId: 'product-photo',
};

const response = (intents: unknown): GLMChatResult => ({
  choices: [{ index: 0, message: { content: JSON.stringify({ intents }), role: 'assistant' } }],
  created: 1,
  id: 'analysis',
  model: 'test',
});
const chatPort = (intents: unknown = [replaceIntent]): GLMMultimodalChatPort => ({
  chat: vi.fn(async () => response(intents)),
  manifest: {
    displayName: 'test',
    model: 'test',
    providerId: 'test',
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId: 'test',
});

const imageCapability = () => {
  const store = new InMemoryPresentationAssetStore();
  const port: ImageGenerationPort = {
    generate: vi.fn(async (_request, context) => [
      {
        asset: { ref: `image:${context.scope.sessionId}:speaker` },
        index: 0,
        metadata: { createdAt: '2026-09-12T00:00:00.000Z', mimeType: 'image/png' },
      },
    ]),
    manifest: {
      displayName: 'Test images',
      providerId: 'images',
      supportedMimeTypes: ['image/png'],
      supportsIdempotency: true,
    },
    providerId: 'images',
    resolveAsset: async () => null,
  };
  return {
    capability: createImageGenerationCapability({
      assetStore: store,
      eventPublisherFactory: (scope) =>
        new ImageGenerationEventPublisher({
          journal: new InMemoryImageGenerationEventJournal({ scope }),
          scope,
        }),
      imagePort: port,
    }),
    port,
    store,
  };
};

describe('presentation revision assets', () => {
  it('extracts intent JSON from think tags, fences, arrays, and mixed prose', () => {
    expect(parseAssetIntentPayload('<think>draft</think>{"intents":[]}')).toEqual({ intents: [] });
    expect(parseAssetIntentPayload('```json\n{"intents":[]}\n```')).toEqual({ intents: [] });
    expect(parseAssetIntentPayload('Here is the plan:\n{"intents":[]}\nDone.')).toEqual({
      intents: [],
    });
    expect(parseAssetIntentPayload('[]')).toEqual({ intents: [] });
    expect(() => parseAssetIntentPayload('not json')).toThrow(/invalid JSON/u);
  });

  it('retries once when the first intent analysis reply is not JSON', async () => {
    const chat = chatPort([]);
    vi.mocked(chat.chat)
      .mockResolvedValueOnce({
        choices: [{ index: 0, message: { content: 'thinking about assets', role: 'assistant' } }],
        created: 1,
        id: 'bad',
        model: 'test',
      })
      .mockResolvedValueOnce(response([]));
    await expect(
      createRevisionAssetPlanner({ chatPort: chat }).prepare(input),
    ).resolves.toMatchObject({ intents: [] });
    expect(chat.chat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chat.chat).mock.calls[1][1]).toMatchObject({
      idempotencyKey: expect.stringMatching(/intent:harvest$/u),
    });
  });

  it('keeps large inline image payloads out of the semantic-analysis text request, including wrapped base64', async () => {
    const payload = `${'A'.repeat(800_000)}\n${'B'.repeat(800_000)}`;
    const embedded = `data:image/png;base64,${payload}`;
    const chat = chatPort([]);
    const inlinePlan: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) =>
        slide.slideId === 'product'
          ? {
              ...slide,
              svg: svg('Product', `<image href="${embedded}" width="400" height="300"/>`),
            }
          : slide,
      ),
    };
    await createRevisionAssetPlanner({ chatPort: chat }).prepare({
      ...input,
      basePlan: inlinePlan,
    });
    const text = JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0].messages);
    expect(text.length).toBeLessThan(12_000);
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('A'.repeat(256));
    expect(text).not.toContain('B'.repeat(256));
    expect(inlinePlan.slides[1].svg).toContain(embedded);
  });

  it('summarizes encoded inline SVG and rejects remaining oversized text before a provider call', () => {
    expect(
      boundPresentationPromptText(`<image href="data:image/svg+xml,${'%20'.repeat(80_000)}"/>`),
    ).toBe('<image href="[embedded image data omitted; use the verified asset reference]"/>');
    expect(() => boundPresentationPromptText('Native vector context '.repeat(10_000))).toThrow(
      'text context is too large',
    );
  });

  it('uses semantic intent to replace only the selected page image through the image capability', async () => {
    const { capability, port, store } = imageCapability();
    const chat = chatPort();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    const result = await planner.prepare(input);

    expect(port.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        prompt: replaceIntent.prompt,
        size: '1024x1536',
        idempotencyKey: expect.any(String),
      }),
      expect.objectContaining({ scope }),
    );
    expect(result.assetArtifactIds).toEqual(['image:session-1:speaker']);
    expect(result.input.options?.generatedImageSlots).toEqual([
      expect.objectContaining({
        assetRefs: [{ ref: 'image:session-1:speaker' }],
        layout: replaceIntent.layout,
        size: '1024x1536',
        slideId: 'product',
        state: 'ready',
      }),
    ]);
    expect(result.input.options?.revisionAssetIntents).toEqual([replaceIntent]);
    expect(await store.find(scope, 'image:session-1:speaker')).not.toBeNull();
    const prompt = vi.mocked(chat.chat).mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('Product');
    expect(prompt).not.toContain('Summary');
    expect(input.basePlan).toEqual(basePlan);
  });

  it('does not generate assets for a wording edit, even when the text mentions an image', async () => {
    const { capability, port } = imageCapability();
    const result = await createRevisionAssetPlanner({
      chatPort: chatPort([]),
      imageGenerationCapability: capability,
    }).prepare({
      ...input,
      revision: { ...input.revision, content: '把标题改成「AI 生成图像」，现有产品照片保持原样' },
    });
    expect(port.generate).not.toHaveBeenCalled();
    expect(result.assetArtifactIds).toEqual([]);
    expect(result.input.options?.generatedImageSlots).toEqual([]);
  });

  it('deduplicates concurrent attempts and isolates idempotency by authenticated scope', async () => {
    const { capability, port } = imageCapability();
    const chat = chatPort();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    const [first, second] = await Promise.all([planner.prepare(input), planner.prepare(input)]);
    expect(first).toEqual(second);
    expect(chat.chat).toHaveBeenCalledTimes(1);
    expect(port.generate).toHaveBeenCalledTimes(1);
    await planner.prepare({
      ...input,
      jobInput: {
        ...input.jobInput,
        options: {
          generatedImageSlots: [{ ref: 'transient-previous-image' }],
          revisionAssetIntents: [{ action: 'reuse' }],
        },
      },
    });
    expect(port.generate).toHaveBeenCalledTimes(1);
    await planner.prepare({ ...input, scope: { ...scope, sessionId: 'session-2' } });
    expect(port.generate).toHaveBeenCalledTimes(2);
    const requests = vi.mocked(port.generate).mock.calls;
    expect(requests[0][0].idempotencyKey).not.toBe(requests[1][0].idempotencyKey);
    await expect(
      planner.prepare({ ...input, revision: { ...input.revision, content: 'Another edit' } }),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });

  it('fails before calling a provider for out-of-scope slides, missing providers and exceeded budgets', async () => {
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, slideId: 'cover' }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort() }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort(), maxGeneratedSlots: 0 }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_BUDGET_EXCEEDED' });
    await expect(
      createRevisionAssetPlanner({ chatPort: chatPort() }).prepare({
        ...input,
        scope: { sessionId: '', userId: '' },
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });

  it('cancels before analysis and between analysis and image generation', async () => {
    const controller = new AbortController();
    const chat = chatPort();
    const { capability, port } = imageCapability();
    const planner = createRevisionAssetPlanner({
      chatPort: chat,
      imageGenerationCapability: capability,
    });
    controller.abort();
    await expect(planner.prepare({ ...input, signal: controller.signal })).rejects.toMatchObject({
      code: 'IMAGE_CANCELLED',
    });
    expect(chat.chat).not.toHaveBeenCalled();

    const during = new AbortController();
    vi.mocked(chat.chat).mockImplementationOnce(async () => {
      during.abort();
      return response([replaceIntent]);
    });
    await expect(planner.prepare({ ...input, signal: during.signal })).rejects.toMatchObject({
      code: 'IMAGE_CANCELLED',
    });
    expect(port.generate).not.toHaveBeenCalled();
  });

  it('does not pass failed image slots to the SVG planner as though they were real assets', async () => {
    const generate = vi.fn(async () => ({
      jobId: input.jobId,
      scope,
      slots: [
        {
          assetRefs: [],
          slideId: 'product',
          slotId: 'edit-1:product-photo',
          state: 'failed' as const,
        },
      ],
    }));
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort(),
        imageGenerationCapability: { generate },
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_UNAVAILABLE' });
  });

  it('rejects image placements outside the canvas and invented existing references', async () => {
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, layout: { ...replaceIntent.layout, width: 1 } }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
    await expect(
      createRevisionAssetPlanner({
        chatPort: chatPort([{ ...replaceIntent, ref: 'not-an-existing-image' }]),
      }).prepare(input),
    ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  });
});

it('composes processing tools for a selected image without invoking image generation', async () => {
  const processing = [
    { id: 'cutout', operation: 'assets.removeBackground', input: { ref: replaceIntent.ref } },
    {
      id: 'fade',
      operation: 'assets.transform',
      input: { ref: { $ref: 'cutout.ref' }, opacity: 0.8 },
    },
  ];
  const processAssets = vi.fn().mockResolvedValue({ ref: 'processed-owned' });
  const generate = vi.fn();
  const planner = createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        action: 'process',
        slideId: 'product',
        slotId: 'cutout',
        ref: replaceIntent.ref,
        layout: replaceIntent.layout,
        processing,
      },
    ]),
    processAssets,
    imageGenerationCapability: { generate },
  });
  const result = await planner.prepare(input);
  expect(generate).not.toHaveBeenCalled();
  expect(processAssets).toHaveBeenCalledWith(processing, input);
  expect(result.assetArtifactIds).toEqual(['processed-owned']);
  expect(result.intents[0]).toMatchObject({
    action: 'replace',
    ref: replaceIntent.ref,
    processing,
  });
});

it('runs cutout after generating a new transparent asset and passes the real source ref', async () => {
  const capability = imageCapability();
  const processAssets = vi.fn().mockResolvedValue({ ref: 'transparent-owned' });
  const planner = createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        ...replaceIntent,
        processing: [
          { id: 'cutout', operation: 'assets.removeBackground', input: { ref: '$source' } },
        ],
      },
    ]),
    imageGenerationCapability: capability.capability,
    processAssets,
  });
  const result = await planner.prepare(input);
  expect(processAssets.mock.calls[0][0][0].input.ref).toMatch(/^image:/);
  expect(result.assetArtifactIds).toEqual(['transparent-owned']);
});

it('places an owned asset made during intake without generating it again, and rejects unknown refs', async () => {
  const intents = [
    {
      action: 'reuse',
      ref: 'intake-watercolor',
      slideId: 'cover',
      slotId: 'illustration',
      layout: { x: 0.55, y: 0.2, width: 0.4, height: 0.6, fit: 'contain' },
    },
  ];
  const chat = chatPort(intents);
  const generate = vi.fn();
  const reuse = vi.fn(async () => [{ ref: 'intake-watercolor', name: '水彩书本' }]);
  const request = {
    ...input,
    revision: {
      content: 'Reuse the watercolor book',
      requestId: 'initial-assets',
      target: { type: 'deck' as const },
    },
    jobInput: { ...input.jobInput, options: { availableAssetRefs: ['intake-watercolor'] } },
  };
  const result = await createRevisionAssetPlanner({
    chatPort: chat,
    imageGenerationCapability: { generate },
    readReusableAssets: reuse,
  }).prepare(request);
  expect(result.assetArtifactIds).toEqual(['intake-watercolor']);
  expect(result.input.options?.generatedImageSlots).toEqual([
    expect.objectContaining({
      slideId: 'cover',
      layout: intents[0].layout,
      assetRefs: [{ ref: 'intake-watercolor' }],
    }),
  ]);
  expect(generate).not.toHaveBeenCalled();
  await expect(
    createRevisionAssetPlanner({ chatPort: chat, readReusableAssets: async () => [] }).prepare(
      request,
    ),
  ).rejects.toThrow('belonging to the selected slide');
});

const componentBox = { height: 0.4, width: 0.3, x: 0.1, y: 0.2 };
const templateVisual = {
  analyzedAt: '2026-01-01T00:00:00.000Z',
  components: [
    {
      box: componentBox,
      containsText: false,
      familyId: 'f1',
      id: 'ribbon',
      name: 'Ribbon',
      page: 1,
      rationale: 'safe decoration',
      role: 'decoration' as const,
      treatment: 'reuse' as const,
    },
    {
      box: { height: 0.2, width: 1, x: 0, y: 0 },
      containsText: true,
      familyId: 'f1',
      id: 'old-title',
      name: 'Title',
      page: 1,
      rationale: 'baked text',
      role: 'heading' as const,
      treatment: 'reuse' as const,
    },
    {
      box: { height: 0.3, width: 0.3, x: 0.6, y: 0.1 },
      containsText: false,
      familyId: 'f1',
      id: 'hero-photo',
      name: 'Photo',
      page: 1,
      rationale: 'redraw artwork',
      role: 'artwork' as const,
      treatment: 'redraw' as const,
    },
    {
      box: { height: 0.15, width: 0.15, x: 0.8, y: 0.8 },
      containsText: false,
      familyId: 'f1',
      id: 'chart',
      name: 'Chart',
      page: 1,
      rationale: 'native chart',
      role: 'artwork' as const,
      treatment: 'native' as const,
    },
    {
      box: { height: 0.5, width: 0.4, x: 0.05, y: 0.3 },
      containsText: false,
      familyId: 'f1',
      id: 'cutout-leaf',
      name: 'Leaf',
      page: 1,
      rationale: 'needs transparency',
      role: 'decoration' as const,
      treatment: 'removeBackground' as const,
    },
  ],
  families: [
    {
      artwork: 'wash',
      composition: 'open',
      id: 'f1',
      name: 'cover',
      pages: [1],
      palette: ['#123456'],
      preserve: [],
      typography: 'serif',
    },
  ],
  guidance: 'keep wash',
  media: [
    {
      confidence: 0.9,
      frameRefs: ['video-frame-1', 'video-frame-2'],
      kind: 'video' as const,
      mediaId: 'slide-1:video:1',
      page: 1,
      preserveRecommendation: 'poster' as const,
      questions: [],
      role: 'decorative' as const,
      status: 'analyzed' as const,
      summary: 'Soft watercolor motion behind the title',
      visualStyle: 'paper grain and a pale wash',
    },
  ],
  model: 'vision',
  pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'template-page-1', width: 1400 }],
  schemaVersion: 1 as const,
  summary: 'watercolor',
  templateId: 'tmpl',
  versionId: 'ver',
};
const visualJobInput = {
  ...input,
  jobInput: { ...input.jobInput, options: { templateVisual } },
  revision: {
    content: '应用模板「水彩」的视觉风格与适合各页内容的版式，保留本稿的主题、事实和文字含义。',
    requestId: 'apply-template',
    target: { type: 'deck' as const },
    template: { templateId: 'tmpl', versionId: 'ver' },
  },
};

it('uses initial art-direction rules when applying a template, not conservative empty edits', async () => {
  const templateChat = chatPort([]);
  const wordingChat = chatPort([]);
  await createRevisionAssetPlanner({ chatPort: templateChat }).prepare(visualJobInput);
  await createRevisionAssetPlanner({ chatPort: wordingChat }).prepare({
    ...input,
    revision: { ...input.revision, content: '把标题改成新产品名' },
  });
  const templateSystem = vi.mocked(templateChat.chat).mock.calls[0][0].messages[0]
    .content as string;
  const wordingSystem = vi.mocked(wordingChat.chat).mock.calls[0][0].messages[0].content as string;
  expect(templateSystem).toContain('INITIAL ART DIRECTION');
  expect(wordingSystem).not.toContain('INITIAL ART DIRECTION');
});

it('shows owned template page pixels to asset direction instead of relying on profile JSON alone', async () => {
  const chat = chatPort([]);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const readVisualReferences = vi.fn(async (refs: string[]) =>
    refs.map((ref) => ({ base64: png, mimeType: 'image/png' as const, ref })),
  );
  await createRevisionAssetPlanner({ chatPort: chat, readVisualReferences }).prepare(
    visualJobInput,
  );
  expect(readVisualReferences).toHaveBeenCalledWith(
    ['template-page-1', 'video-frame-1', 'video-frame-2'],
    visualJobInput,
  );
  const [request, context] = vi.mocked(chat.chat).mock.calls[0];
  expect(context.trustedImages?.urls).toHaveLength(3);
  expect(Array.isArray(request.messages[1].content)).toBe(true);
  expect(JSON.stringify(request.messages[1].content)).toContain('模板视觉证据');
});

it('defaults template component reuse to the learned box and rejects text, redraw, native, or unprocessed cutouts', async () => {
  const extractTemplateComponent = vi.fn(async () => ({
    needsTransparency: false,
    ref: 'extracted-ribbon',
  }));
  const processAssets = vi.fn(async () => ({ ref: 'cutout-owned' }));
  const reuse = await createRevisionAssetPlanner({
    chatPort: chatPort([
      { action: 'reuse', componentId: 'ribbon', slideId: 'cover', slotId: 'ribbon-slot' },
    ]),
    extractTemplateComponent,
  }).prepare(visualJobInput);
  expect(reuse.intents[0]).toMatchObject({
    action: 'reuse',
    componentId: 'ribbon',
    layout: { ...componentBox, fit: 'contain' },
  });
  expect(extractTemplateComponent).toHaveBeenCalledWith('ribbon', visualJobInput);

  const customLayout = { fit: 'cover' as const, height: 0.5, width: 0.4, x: 0.55, y: 0.2 };
  const placed = await createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        action: 'reuse',
        componentId: 'ribbon',
        layout: customLayout,
        slideId: 'cover',
        slotId: 'ribbon-slot',
      },
    ]),
    extractTemplateComponent,
  }).prepare({ ...visualJobInput, revision: { ...visualJobInput.revision, requestId: 'apply-2' } });
  expect(placed.intents[0].layout).toEqual(customLayout);

  await expect(
    createRevisionAssetPlanner({
      chatPort: chatPort([
        { action: 'reuse', componentId: 'old-title', slideId: 'cover', slotId: 'title' },
      ]),
      extractTemplateComponent,
    }).prepare({
      ...visualJobInput,
      revision: { ...visualJobInput.revision, requestId: 'apply-3' },
    }),
  ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  await expect(
    createRevisionAssetPlanner({
      chatPort: chatPort([
        { action: 'reuse', componentId: 'hero-photo', slideId: 'cover', slotId: 'hero' },
      ]),
      extractTemplateComponent,
    }).prepare({
      ...visualJobInput,
      revision: { ...visualJobInput.revision, requestId: 'apply-4' },
    }),
  ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  await expect(
    createRevisionAssetPlanner({
      chatPort: chatPort([
        { action: 'reuse', componentId: 'chart', slideId: 'cover', slotId: 'chart' },
      ]),
      extractTemplateComponent,
    }).prepare({
      ...visualJobInput,
      revision: { ...visualJobInput.revision, requestId: 'apply-5' },
    }),
  ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });
  await expect(
    createRevisionAssetPlanner({
      chatPort: chatPort([
        { action: 'reuse', componentId: 'cutout-leaf', slideId: 'cover', slotId: 'leaf' },
      ]),
      extractTemplateComponent,
    }).prepare({
      ...visualJobInput,
      revision: { ...visualJobInput.revision, requestId: 'apply-6' },
    }),
  ).rejects.toMatchObject({ code: 'IMAGE_PLAN_INVALID' });

  const processed = await createRevisionAssetPlanner({
    chatPort: chatPort([
      {
        action: 'reuse',
        componentId: 'cutout-leaf',
        processing: [
          { id: 'cutout', input: { ref: '$source' }, operation: 'assets.removeBackground' },
        ],
        slideId: 'cover',
        slotId: 'leaf',
      },
    ]),
    extractTemplateComponent: async () => ({ needsTransparency: true, ref: 'leaf-source' }),
    processAssets,
  }).prepare({ ...visualJobInput, revision: { ...visualJobInput.revision, requestId: 'apply-7' } });
  expect(processAssets).toHaveBeenCalled();
  expect(processed.assetArtifactIds).toEqual(['cutout-owned']);
  expect(processed.intents[0].layout).toEqual({
    ...templateVisual.components[4].box,
    fit: 'contain',
  });
});

it('tells initial art direction to generate new subjects instead of pasting template photos', async () => {
  const templateChat = chatPort([]);
  await createRevisionAssetPlanner({ chatPort: templateChat }).prepare(visualJobInput);
  const templateSystem = vi.mocked(templateChat.chat).mock.calls[0][0].messages[0]
    .content as string;
  expect(templateSystem).toContain('style lock');
  expect(templateSystem).toContain('Never paste original template photographs');
});

it('draws with learned style references then cuts out overlapping slots', async () => {
  const generateIntent = {
    action: 'generate' as const,
    layout: { fit: 'contain' as const, height: 0.7, width: 0.4, x: 0.55, y: 0.15 },
    prompt: 'A watercolor robot holding a notebook, no text.',
    size: '1024x1024' as const,
    slideId: 'cover',
    slotId: 'hero',
  };
  const second = {
    ...generateIntent,
    prompt: 'Watercolor stationery on textured paper, no text.',
    slideId: 'product',
    slotId: 'prop',
  };
  const generate = vi.fn(async (_scope, slots: Array<{ slotId: string; slideId: string }>) => ({
    jobId: visualJobInput.jobId,
    scope,
    slots: slots.map((slot) => ({
      assetRefs: [{ ref: `drawn:${slot.slotId}` }],
      slideId: slot.slideId,
      slotId: slot.slotId,
      state: 'ready' as const,
    })),
  }));
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const processAssets = vi.fn(async () => {
    started += 1;
    const id = started;
    if (id === 1) await gate;
    return { ref: `cut-${id}` };
  });
  const pending = createRevisionAssetPlanner({
    chatPort: chatPort([generateIntent, second]),
    imageGenerationCapability: { generate },
    processAssets,
  }).prepare({
    ...visualJobInput,
    revision: { ...visualJobInput.revision, requestId: 'initial-assets' },
  });
  await vi.waitFor(() => expect(started).toBe(2));
  release();
  const result = await pending;
  expect(generate).toHaveBeenCalledTimes(2);
  const generatedSlots = generate.mock.calls.map((call) => call[1][0]);
  expect(generatedSlots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        background: 'opaque',
        prompt: expect.stringContaining('STYLE REFERENCE ONLY'),
        referenceAssetRefs: ['template-page-1'],
      }),
    ]),
  );
  expect(generatedSlots.some((slot) => slot.prompt.includes('watercolor robot'))).toBe(true);
  expect(processAssets.mock.calls[0][0][0].input.ref).toMatch(/^drawn:/);
  expect(result.assetArtifactIds).toEqual(['cut-1', 'cut-2']);
});
