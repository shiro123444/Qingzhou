import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationJobInput,
  PresentationPlan,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { ImageGenerationSlot } from './image-generation-planner';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { createGLMPresentationPlanner } from './multimodal-planner-glm';
import { createRevisionAssetPlanner } from './revision-assets';
import { extractPlanTemplate } from './templates';

const mockScope: RuntimeScope = {
  sessionId: 'test-session',
  userId: 'test-user',
};

describe('GLMPresentationPlanner (C-106)', () => {
  it('fails closed when authenticated planner scope is missing', async () => {
    const chat = vi.fn();
    const planner = createGLMPresentationPlanner({
      chatPort: {
        chat,
        manifest: {
          displayName: 'test',
          model: 'test-model',
          providerId: 'test-provider',
          supportsIdempotency: true,
          supportsVision: true,
        },
        providerId: 'test-provider',
      },
    });

    await expect(
      planner.plan({ notebookId: 'notebook-1', sourceVersionIds: [], title: 'Scope test' }, {}),
    ).rejects.toThrow('authenticated planner scope is required');
    expect(chat).not.toHaveBeenCalled();
  });

  it('retries once when the first planner reply is empty', async () => {
    const svg =
      '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#ffffff"/></svg>';
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ index: 0, message: { content: '', role: 'assistant' } }],
        created: 1,
        id: 'empty',
        model: 'test',
      })
      .mockResolvedValueOnce({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                aspectRatio: '16:9',
                planId: 'plan-retry',
                slides: [{ order: 1, slideId: 'slide-1', svg }],
                sourceVersionIds: [],
                title: 'Retry',
              }),
              role: 'assistant',
            },
          },
        ],
        created: 1,
        id: 'ok',
        model: 'test',
      });
    const planner = createGLMPresentationPlanner({
      chatPort: {
        chat,
        manifest: {
          displayName: 'test',
          model: 'test',
          providerId: 'test',
          supportsIdempotency: true,
          supportsVision: true,
        },
        providerId: 'test',
      },
    });
    await expect(
      planner.plan(
        { notebookId: 'nb', slideCount: 1, sourceVersionIds: [], title: 'Retry' },
        { scope: mockScope },
      ),
    ).resolves.toMatchObject({ planId: 'plan-retry' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][1]).toMatchObject({
      idempotencyKey: 'structured-json:harvest',
    });
  });

  it('generates a validated presentation plan from user job input', async () => {
    let capturedRequest: any;

    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async (req) => {
        capturedRequest = req;
        return {
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  aspectRatio: '16:9',
                  planId: 'plan-123',
                  slides: [
                    {
                      order: 1,
                      slideId: 'slide-1',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#ffffff"/><text x="100" y="200">Title Slide</text></svg>',
                    },
                    {
                      order: 2,
                      slideId: 'slide-2',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#ffffff"/><text x="100" y="200">Agenda Slide</text></svg>',
                    },
                  ],
                  title: '2026 商业规划',
                }),
                role: 'assistant' as const,
              },
            },
          ],
          created: 1700000000,
          id: 'chatcmpl-plan-1',
          model: 'glm-5.3-flash',
        };
      }),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    const planner = createGLMPresentationPlanner({ chatPort: mockChatPort });

    const input: PresentationJobInput = {
      aspectRatio: '16:9',
      language: 'zh-CN',
      notebookId: 'nb-1',
      options: {
        references: [{ name: 'logo.png', url: 'https://cdn.example.com/logo.png' }],
      },
      prompt: '为高管汇报准备的商业计划书',
      slideCount: 2,
      sourceVersionIds: ['v1'],
      title: '2026 商业规划',
    };

    const plan = await planner.plan(input, { scope: mockScope });

    expect(plan.title).toBe('2026 商业规划');
    expect(plan.aspectRatio).toBe('16:9');
    expect(plan.slides).toHaveLength(2);
    expect(plan.slides[0].slideId).toBe('slide-1');
    expect(plan.slides[1].slideId).toBe('slide-2');

    // Verify chat port received vision input for reference image
    const userMessage = capturedRequest.messages[1];
    expect(userMessage.content).toEqual([
      {
        text: '主题：2026 商业规划\n详细需求：为高管汇报准备的商业计划书\n目标页数：2\n画幅比例：16:9\n主语言：zh-CN',
        type: 'text',
      },
      {
        image_url: { url: 'https://cdn.example.com/logo.png' },
        type: 'image_url',
      },
    ]);
  });

  it('passes generated https image assets to the multimodal planner and names their slide slots', async () => {
    let capturedRequest: any;
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async (req) => {
        capturedRequest = req;
        return {
          choices: [
            {
              index: 0,
              message: {
                content: JSON.stringify({
                  planId: 'plan-image',
                  slides: [
                    {
                      order: 1,
                      slideId: 'slide-1',
                      svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.com/hero.png" width="960" height="540"/></svg>',
                    },
                  ],
                  title: '带视觉素材的演示文稿',
                }),
                role: 'assistant' as const,
              },
            },
          ],
          created: 1,
          id: 'chatcmpl-image',
          model: 'glm-5.3-flash',
        };
      }),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };
    const planner = createGLMPresentationPlanner({ chatPort: mockChatPort });

    await planner.plan(
      {
        notebookId: 'nb-image',
        options: {
          generatedImageSlots: [
            {
              assetRefs: [{ ref: 'https://cdn.example.com/hero.png' }],
              slideId: 'slide-1',
              slotId: 'hero-visual',
              state: 'ready',
            },
          ],
        },
        slideCount: 1,
        sourceVersionIds: [],
        title: '带视觉素材的演示文稿',
      },
      { scope: mockScope },
    );

    const parts = capturedRequest.messages[1].content;
    expect(parts[0].text).toContain('页面: slide-1, 槽位: hero-visual');
    expect(parts[0].text).toContain('https://cdn.example.com/hero.png');
    expect(parts).toContainEqual({
      image_url: { url: 'https://cdn.example.com/hero.png' },
      type: 'image_url',
    });
  });

  it('injects page-bound asset references into the reserved visual area', async () => {
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({
                aspectRatio: '16:9',
                planId: 'plan-inject',
                slides: [
                  {
                    order: 1,
                    slideId: 'slide-1',
                    svg: '<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><text x="20" y="40">正文</text></svg>',
                  },
                ],
                title: '素材注入',
              }),
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'chatcmpl-inject',
        model: 'glm-5.3-flash',
      })),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    const plan = await createGLMPresentationPlanner({ chatPort: mockChatPort }).plan(
      {
        notebookId: 'nb-inject',
        options: {
          generatedImageSlots: [
            {
              assetRefs: [{ ref: 'https://cdn.example.com/hero.png' }],
              layout: { fit: 'contain', height: 0.4, width: 0.8, x: 0.1, y: 0.3 },
              slideId: 'slide-1',
              slotId: 'hero-visual',
              state: 'ready',
            },
          ],
        },
        slideCount: 1,
        sourceVersionIds: [],
        title: '素材注入',
      },
      { scope: mockScope },
    );

    const svg = plan.slides[0].svg;
    expect(svg).toContain('href="https://cdn.example.com/hero.png"');
    expect(svg.indexOf('<image')).toBeLessThan(svg.indexOf('<text'));
    expect(svg).toContain('x="96"');
    expect(svg).toContain('y="162"');
    expect(svg).toContain('width="768"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('fails honestly when the model omits a requested slide or returns invalid SVG', async () => {
    const mockChatPort: GLMMultimodalChatPort = {
      chat: vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: JSON.stringify({ planId: 'bad', slides: [], title: '坏计划' }),
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'chatcmpl-bad',
        model: 'glm-5.3-flash',
      })),
      manifest: {
        displayName: 'GLM Multimodal Chat',
        model: 'glm-5.3-flash',
        providerId: 'glm-chat',
        supportsIdempotency: true,
        supportsVision: true,
      },
      providerId: 'glm-chat',
    };

    await expect(
      createGLMPresentationPlanner({ chatPort: mockChatPort }).plan(
        { notebookId: 'nb-bad', slideCount: 1, sourceVersionIds: [], title: '坏计划' },
        { scope: mockScope },
      ),
    ).rejects.toMatchObject({ code: 'PLAN_INVALID' });
  });
});

describe('dynamic image revision and learned layout planning', () => {
  const imageHref = '/api/runtime/presentation/artifacts/product-old';
  const slideSvg = (text: string, image = '') =>
    `<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg"><text x="40" y="100">${text}</text>${image}</svg>`;
  const basePlan: PresentationPlan = {
    aspectRatio: '16:9',
    planId: 'base',
    slides: [
      { order: 1, slideId: 'intro', svg: slideSvg('Intro') },
      {
        order: 2,
        slideId: 'product',
        svg: slideSvg(
          'Product',
          `<image href="${imageHref}" x="520" y="130" width="390" height="300"/>`,
        ),
      },
      { order: 3, slideId: 'outro', svg: slideSvg('Outro') },
    ],
    sourceVersionIds: [],
    title: 'Deck',
  };
  const jobInput: PresentationJobInput = {
    notebookId: 'nb',
    slideCount: 3,
    sourceVersionIds: [],
    title: 'Deck',
  };
  const revision = {
    content: 'Replace the product photograph and put the text on the left',
    requestId: 'rev-1',
    target: { slideNumber: 2, type: 'slide' as const },
  };
  const makePort = (result: object): GLMMultimodalChatPort => ({
    chat: vi.fn(async () => ({
      choices: [
        { index: 0, message: { content: JSON.stringify(result), role: 'assistant' as const } },
      ],
      created: 1,
      id: 'response',
      model: 'test',
    })),
    manifest: {
      displayName: 'test',
      model: 'test',
      providerId: 'test',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'test',
  });

  it('generates a real replacement reference, arranges it in the designed region and retains both other pages', async () => {
    const assetPlanner = createRevisionAssetPlanner({
      chatPort: makePort({
        intents: [
          {
            action: 'replace',
            layout: { fit: 'contain', height: 0.7, width: 0.4, x: 0.55, y: 0.2 },
            prompt: 'A studio product photograph',
            ref: imageHref,
            size: '1024x1536',
            slideId: 'product',
            slotId: 'hero',
          },
        ],
      }),
      imageGenerationCapability: {
        generate: vi.fn(async (scope: RuntimeScope, slots: readonly ImageGenerationSlot[]) => ({
          jobId: 'job',
          scope,
          slots: slots.map((slot) => ({
            assetRefs: [{ ref: 'product-new' }],
            slideId: slot.slideId,
            slotId: slot.slotId,
            state: 'ready' as const,
          })),
        })),
      },
    });
    const prepared = await assetPlanner.prepare({
      basePlan,
      jobId: 'job',
      jobInput,
      revision,
      scope: mockScope,
    });
    const port = makePort({
      planId: 'updated',
      slides: [{ slideId: 'product', svg: slideSvg('Revised description') }],
    });
    const plan = await createGLMPresentationPlanner({ chatPort: port }).plan(prepared.input, {
      basePlan,
      revision,
      scope: mockScope,
    });
    expect(plan.slides[0]).toEqual(basePlan.slides[0]);
    expect(plan.slides[2]).toEqual(basePlan.slides[2]);
    expect(plan.slides[1].slideId).toBe('product');
    expect(plan.slides[1].svg).toContain('href="/api/runtime/presentation/artifacts/product-new"');
    expect(plan.slides[1].svg).not.toContain('product-old');
    expect(plan.slides[1].svg).toContain('x="528"');
    expect(plan.slides[1].svg).toContain('width="384"');
    expect(plan.slides[1].svg).toContain('Revised description');
    expect(JSON.stringify(vi.mocked(port.chat).mock.calls[0][0])).toContain('1024x1536');
  });

  it('refuses silent image removal during a wording revision', async () => {
    const port = makePort({ slides: [{ slideId: 'product', svg: slideSvg('Revised wording') }] });
    await expect(
      createGLMPresentationPlanner({ chatPort: port }).plan(jobInput, {
        basePlan,
        revision: { ...revision, content: 'Shorten the title only' },
        scope: mockScope,
      }),
    ).rejects.toThrow('image that should be preserved');
  });

  it('retains existing asset associations, title and speaker notes through a text-only asset preparation and revision', async () => {
    const original: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) =>
        slide.slideId === 'product'
          ? {
              ...slide,
              metadata: { generatedAssetRefs: ['product-old'], title: 'Original product title' },
              notes: 'Remember to demonstrate the product.',
            }
          : slide,
      ),
    };
    const textRevision = {
      ...revision,
      content: 'Shorten only the description; preserve the image and speaker notes.',
    };
    const assets = createRevisionAssetPlanner({ chatPort: makePort({ intents: [] }) });
    const prepared = await assets.prepare({
      basePlan: original,
      jobId: 'job',
      jobInput,
      revision: textRevision,
      scope: mockScope,
    });
    expect(prepared.input.options?.generatedImageSlots).toEqual([]);
    const revisedSvg = original.slides[1].svg.replace('Product</text>', 'Short description</text>');
    const port = makePort({
      slides: [
        {
          metadata: { generatedAssetRefs: ['model-invented-image'] },
          slideId: 'product',
          svg: revisedSvg,
        },
      ],
    });
    const result = await createGLMPresentationPlanner({ chatPort: port }).plan(prepared.input, {
      basePlan: original,
      revision: textRevision,
      scope: mockScope,
    });
    expect(result.slides[1]).toMatchObject({
      metadata: { generatedAssetRefs: ['product-old'], title: 'Original product title' },
      notes: 'Remember to demonstrate the product.',
      svg: revisedSvg,
    });
    expect(result.slides[0]).toEqual(original.slides[0]);
    expect(result.slides[2]).toEqual(original.slides[2]);
  });

  it('maps a selected revision back to its original outline page', async () => {
    const outlinedInput: PresentationJobInput = {
      ...jobInput,
      options: {
        outline: [
          { keyPoints: ['Intro point'], objective: 'Introduce', title: 'Intro outline' },
          { keyPoints: ['Product point'], objective: 'Explain', title: 'Product outline' },
          { keyPoints: ['Outro point'], objective: 'Close', title: 'Outro outline' },
        ],
      },
    };
    const port = makePort({
      slides: [{ slideId: 'product', svg: basePlan.slides[1].svg }],
    });

    const result = await createGLMPresentationPlanner({ chatPort: port }).plan(outlinedInput, {
      basePlan,
      revision: { ...revision, content: 'Tighten spacing only.' },
      scope: mockScope,
    });

    expect(result.slides[1]).toMatchObject({
      metadata: {
        outline: ['Product point'],
        objective: 'Explain',
        title: 'Product outline',
      },
      order: 2,
      slideId: 'product',
    });
    expect(result.slides[0]).toEqual(basePlan.slides[0]);
    expect(result.slides[2]).toEqual(basePlan.slides[2]);
  });

  it('drops removed image associations and honors an explicit empty speaker note', async () => {
    const original: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) =>
        slide.slideId === 'product'
          ? {
              ...slide,
              metadata: { generatedAssetRefs: ['product-old'], title: 'Original product title' },
              notes: 'Notes to clear',
            }
          : slide,
      ),
    };
    const assets = createRevisionAssetPlanner({
      chatPort: makePort({
        intents: [{ action: 'remove', ref: imageHref, slideId: 'product', slotId: 'hero' }],
      }),
    });
    const prepared = await assets.prepare({
      basePlan: original,
      jobId: 'job',
      jobInput,
      revision,
      scope: mockScope,
    });
    const port = makePort({
      slides: [
        {
          metadata: { generatedAssetRefs: ['product-old', 'model-invented-image'] },
          notes: '',
          slideId: 'product',
          svg: slideSvg('Only text now'),
          title: 'New title',
        },
      ],
    });
    const result = await createGLMPresentationPlanner({ chatPort: port }).plan(prepared.input, {
      basePlan: original,
      revision,
      scope: mockScope,
    });
    expect(result.slides[1]).toMatchObject({
      metadata: { generatedAssetRefs: [], title: 'New title' },
      notes: '',
    });
  });

  it('refuses fabricated references and off-canvas placement', async () => {
    const imageInput = {
      ...jobInput,
      options: {
        generatedImageSlots: [
          {
            assetRefs: [{ ref: 'real-image' }],
            slideId: 'slide-1',
            slotId: 'hero',
            state: 'ready',
          },
        ],
      },
      slideCount: 1,
    };
    await expect(
      createGLMPresentationPlanner({
        chatPort: makePort({
          slides: [
            {
              slideId: 'slide-1',
              svg: slideSvg('Title', '<image href="/made-up-image.png" width="400" height="300"/>'),
            },
          ],
        }),
      }).plan(imageInput, { scope: mockScope }),
    ).rejects.toThrow('did not place');
    await expect(
      createGLMPresentationPlanner({
        chatPort: makePort({
          slides: [
            {
              slideId: 'slide-1',
              svg: slideSvg(
                'Title',
                '<image href="/api/runtime/presentation/artifacts/real-image" x="900" width="400" height="300"/>',
              ),
            },
          ],
        }),
      }).plan(imageInput, { scope: mockScope }),
    ).rejects.toThrow('outside the slide');
  });

  it('repairs an invented image href once and keeps the approved generated asset', async () => {
    const bad = {
      slides: [
        {
          slideId: 'slide-1',
          svg: slideSvg(
            'Title',
            '<image href="/invented-template-image.png" x="20" y="20" width="100" height="100"/>',
          ),
        },
      ],
    };
    const good = {
      slides: [
        {
          slideId: 'slide-1',
          svg: slideSvg(
            'Title',
            '<image href="/api/runtime/presentation/artifacts/real-image" x="480" y="108" width="384" height="324"/>',
          ),
        },
      ],
    };
    const response = (value: object) => ({
      choices: [
        { index: 0, message: { content: JSON.stringify(value), role: 'assistant' as const } },
      ],
      created: 1,
      id: 'response',
      model: 'test',
    });
    const port = makePort(bad);
    vi.mocked(port.chat).mockResolvedValueOnce(response(bad)).mockResolvedValueOnce(response(good));

    const plan = await createGLMPresentationPlanner({ chatPort: port }).plan(
      {
        ...jobInput,
        options: {
          generatedImageSlots: [
            {
              assetRefs: [{ ref: 'real-image' }],
              layout: { fit: 'contain', height: 0.6, width: 0.4, x: 0.5, y: 0.2 },
              slideId: 'slide-1',
              slotId: 'hero',
              state: 'ready',
            },
          ],
        },
        slideCount: 1,
      },
      { scope: mockScope },
    );

    expect(plan.slides[0].svg).toContain('href="/api/runtime/presentation/artifacts/real-image"');
    expect(plan.slides[0].svg).not.toContain('invented-template-image');
    expect(port.chat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(port.chat).mock.calls[1][1].idempotencyKey).toBe('structured-json:repair');
  });

  it('passes learned geometry and capacity to the model rather than only a style name', async () => {
    const template = {
      ...extractPlanTemplate(basePlan),
      name: 'Product template',
      templateId: 'template',
      versionId: 'version',
    };
    const port = makePort({
      slides: basePlan.slides.map((slide) => ({ ...slide, svg: slideSvg('Current content') })),
    });
    await createGLMPresentationPlanner({ chatPort: port }).plan(jobInput, {
      scope: mockScope,
      template,
    });
    const prompt = JSON.stringify(vi.mocked(port.chat).mock.calls[0][0]);
    expect(prompt).toContain('assetSlots');
    expect(prompt).toContain('textCapacity');
    expect(prompt).toContain('normalized positions');
    expect(prompt).toContain('template');
  });

  it('shows the model scoped image bytes while ignoring untrusted client data references', async () => {
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const port = makePort({
      slides: [
        {
          slideId: 'slide-1',
          svg: slideSvg(
            'Product',
            '<image href="/api/runtime/presentation/artifacts/new-photo" x="520" y="130" width="390" height="300"/>',
          ),
        },
      ],
    });
    const prepared: PresentationJobInput = {
      ...jobInput,
      options: {
        generatedImageSlots: [{ assetRefs: [{ ref: 'new-photo' }], slideId: 'slide-1' }],
        references: [{ url: 'data:image/png;base64,untrusted-client-input' }],
      },
      slideCount: 1,
    };
    await createGLMPresentationPlanner({ chatPort: port }).plan(prepared, {
      scope: mockScope,
      trustedImages: [
        { base64, mimeType: 'image/png', ref: 'new-photo' },
        { base64: 'invalid-other-page-bytes', mimeType: 'image/png', ref: 'other-page-photo' },
      ],
    });
    const [request, context] = vi.mocked(port.chat).mock.calls[0];
    expect(JSON.stringify(request)).toContain(`data:image/png;base64,${base64}`);
    expect(JSON.stringify(request)).not.toContain('untrusted-client-input');
    expect(JSON.stringify(request)).not.toContain('invalid-other-page-bytes');
    expect(context.trustedImages?.urls).toEqual([`data:image/png;base64,${base64}`]);
  });

  it('bounds the final text context for historical inline slides and embedded template image references', async () => {
    const payload = 'A'.repeat(1_700_000);
    const embedded = `data:image/png;base64,${payload}`;
    const original: PresentationPlan = {
      ...basePlan,
      slides: basePlan.slides.map((slide) =>
        slide.slideId === 'product'
          ? {
              ...slide,
              svg: slideSvg(
                'Product',
                `<image href="${embedded}" x="520" y="130" width="390" height="300"/>`,
              ),
            }
          : slide,
      ),
    };
    const learned = extractPlanTemplate(basePlan);
    const template = {
      ...learned,
      layouts: learned.layouts.map((layout) => ({
        ...layout,
        assetSlots: [
          {
            aspectRatio: 1,
            box: { height: 0.5, width: 0.5, x: 0.4, y: 0.3 },
            fit: 'contain' as const,
            reference: embedded,
            slotId: 'reference',
          },
        ],
        referenceSvg: slideSvg(
          'Reference title',
          `<image href="data:image/png;base64,${'B'.repeat(12_000)}" width="400" height="300"/>`,
        ),
      })),
      name: 'Historical image template',
      templateId: 'template',
      versionId: 'version',
    };
    const port = makePort({});
    vi.mocked(port.chat).mockRejectedValueOnce(
      new Error('Stop after capturing the bounded request'),
    );
    await expect(
      createGLMPresentationPlanner({ chatPort: port }).plan(jobInput, {
        basePlan: original,
        revision,
        scope: mockScope,
        template,
      }),
    ).rejects.toThrow('Stop after capturing');
    const request = vi.mocked(port.chat).mock.calls[0][0];
    const text = JSON.stringify(request.messages);
    expect(text.length).toBeLessThan(30_000);
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('A'.repeat(256));
    expect(text).not.toContain('B'.repeat(256));
    expect(text).toContain('embedded image data omitted');
    expect(original.slides[1].svg).toContain(embedded);
  });

  it('maps returned pages by their identities when the model reorders them', async () => {
    const port = makePort({ slides: [...basePlan.slides].reverse() });
    const updated = await createGLMPresentationPlanner({ chatPort: port }).plan(jobInput, {
      basePlan,
      revision: { ...revision, target: { type: 'deck' } },
      scope: mockScope,
    });
    expect(updated.slides.map((slide) => slide.svg)).toEqual(
      basePlan.slides.map((slide) => slide.svg),
    );
    const wrongPage = makePort({ slides: [{ slideId: 'outro', svg: slideSvg('Wrong page') }] });
    await expect(
      createGLMPresentationPlanner({ chatPort: wrongPage }).plan(jobInput, {
        basePlan,
        revision,
        scope: mockScope,
      }),
    ).rejects.toThrow('retain each selected slide id');
  });
});

it('publishes the first real draft before asking the model to compose the next page', async () => {
  const events: string[] = [];
  const chat: GLMMultimodalChatPort = {
    providerId: 'test',
    manifest: {
      providerId: 'test',
      model: 'test',
      displayName: 'test',
      supportsVision: true,
      supportsIdempotency: true,
    },
    chat: vi.fn<GLMMultimodalChatPort['chat']>(async () => {
      const page = events.filter((event) => event.startsWith('model')).length + 1;
      events.push(`model-${page}`);
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                planId: `plan-${page}`,
                title: 'Deck',
                slides: [
                  {
                    slideId: 'model-local-id',
                    order: 1,
                    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="100" y="100">Page ${page}</text></svg>`,
                  },
                ],
              }),
            },
          },
        ],
        created: 1,
        id: 'test',
        model: 'test',
      };
    }),
  };
  const outline = [1, 2].map((page) => ({
    id: `outline-${page}`,
    title: `Title ${page}`,
    objective: `Claim ${page}`,
    keyPoints: [`Point ${page}`],
  }));
  const plan = await createGLMPresentationPlanner({ chatPort: chat }).plan(
    {
      notebookId: 'test',
      sourceVersionIds: [],
      title: 'Deck',
      slideCount: 2,
      options: { outline },
    },
    {
      scope: mockScope,
      onSlideDraft: async (slide: any) => {
        events.push(`draft-${slide.slideId}`);
        expect(slide.svg).toContain('Page');
      },
    },
  );
  expect(events).toEqual(['model-1', 'draft-slide-1', 'model-2', 'draft-slide-2']);
  expect(plan.slides.map((page) => page.slideId)).toEqual(['slide-1', 'slide-2']);
  expect(plan.slides[1].metadata).toMatchObject({ objective: 'Claim 2', outline: ['Point 2'] });
});
