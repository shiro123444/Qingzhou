import { describe, expect, it, vi } from 'vitest';

import {
  contentInputFingerprint,
  createPresentationContentCompiler,
  readContentIntents,
} from './content-intent';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';

const scope = { userId: 'owner', sessionId: 'session' };

it('restores prose columns from cached conceptual chart misclassification without removing real matrices or relationships', () => {
  const intent = (brief: string, kind = 'chart') => ({
    slideId: 'slide-1',
    claim: '方案条件',
    formulas: [],
    visualKind: kind,
    visualReason: '并列说明',
    visuals: [
      {
        id: 'visual-1',
        kind,
        renderer: 'native',
        fidelity: 'conceptual',
        required: true,
        brief,
      },
    ],
  });
  const read = (brief: string, kind = 'chart') =>
    readContentIntents({
      title: '方案',
      notebookId: 'n',
      sourceVersionIds: [],
      options: { contentIntents: { slides: [intent(brief, kind)] } },
    })[0];
  expect(
    read('三栏并列说明，无流程箭头。资料追溯、协作边界、发布条件分别用可编辑文字展示。'),
  ).toMatchObject({ visualKind: 'none', visuals: [] });
  expect(
    read(
      '原生三栏并列说明，不是流程、不是定量图表。左栏介绍资料追溯，中栏介绍协作边界，右栏介绍发布条件。',
    ),
  ).toMatchObject({ visualKind: 'none', visuals: [] });
  expect(
    read(
      '双栏并列、不加箭头：左栏集中交接，右栏分散交接，分别介绍做法、适用条件和注意事项。',
      'scientific-diagram',
    ),
  ).toMatchObject({ visualKind: 'none', visuals: [] });
  expect(
    read('三栏并列说明指标矩阵，表头为阶段、收入、成本，每行保留真实数据。').visuals,
  ).toHaveLength(1);
  expect(read('三栏并列说明三个节点，用有向连接线表达父子关系。').visuals).toHaveLength(1);
});
function port(originalIdentities = false) {
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async (request) => {
    const payload = JSON.parse(request.messages.at(-1)!.content as string);
    const slides = Array.from({ length: payload.slideCount }, (_, index) => ({
      slideId: `slide-${originalIdentities ? (payload.originalSlideNumbers?.[index] ?? index + 1) : index + 1}`,
      claim: payload.outline[index].title,
      formulas: [],
      visualKind: 'none',
      visualReason: '保留现有内容',
      visuals: [] as any[],
    }));
    if (payload.originalSlideNumbers?.some((number: number) => [12, 15].includes(number))) {
      for (const [index, number] of payload.originalSlideNumbers.entries())
        if ([12, 15].includes(number)) {
          slides[index].visualKind = 'illustration';
          slides[index].visualReason = '用原创场景解释协作';
          slides[index].visuals = [
            {
              id: 'concept',
              kind: 'illustration',
              renderer: 'image',
              fidelity: 'conceptual',
              required: true,
              brief: '统一蓝白金色的原创协作概念插画，不虚构成果或数据',
            },
          ];
        }
    }
    return {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify({ slides }) },
        },
      ],
      created: 1,
      id: 'chat',
      model: 'test',
    };
  });
  return {
    chat,
    providerId: 'test',
    manifest: {
      model: 'test',
      providerId: 'test',
      displayName: 'test',
      supportsIdempotency: true,
      supportsVision: true,
    },
  } satisfies GLMMultimodalChatPort;
}

describe('bounded content compilation', () => {
  it('replans cached visual direction when the role model routing changes but keeps legacy caches stable', async () => {
    const direction = {
      illustrationStyle: 'restrained flat drawing',
      continuityRules: ['keep shared typography'],
      slides: [
        {
          slideId: 'slide-1',
          strategy: 'native',
          reason: 'editable content',
          priority: 0,
          composition: 'balanced columns',
          capabilityIds: [],
        },
      ],
    };
    const chat = port();
    chat.chat.mockResolvedValue({
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(direction) } }],
      created: 1,
      id: 'direction',
      model: 'test',
    });
    const input = {
      notebookId: 'n',
      title: '资料复核',
      sourceVersionIds: [],
      slideCount: 1,
      options: { outline: [{ title: '共享事实', keyPoints: ['同一条批准事实'] }] },
    };
    const compiler = createPresentationContentCompiler(chat, 1, {
      imageGenerationAvailable: true,
    });
    const legacy = await compiler.prepareVisualDirection!(input, { scope });
    expect(await compiler.prepareVisualDirection!(legacy, { scope })).toBe(legacy);
    expect(contentInputFingerprint(input)).toBe(
      contentInputFingerprint({
        ...input,
        options: { ...input.options, agentRoutingFingerprint: undefined },
      }),
    );
    expect(chat.chat).toHaveBeenCalledOnce();
    const routed = await compiler.prepareVisualDirection!(
      { ...legacy, options: { ...legacy.options, agentRoutingFingerprint: 'content-model-a' } },
      { scope },
    );
    expect(routed.options?.visualDirectionFingerprint).not.toBe(
      legacy.options?.visualDirectionFingerprint,
    );
    expect(await compiler.prepareVisualDirection!(routed, { scope })).toBe(routed);
    expect(chat.chat).toHaveBeenCalledTimes(2);
    const changed = await compiler.prepareVisualDirection!(
      { ...routed, options: { ...routed.options, agentRoutingFingerprint: 'content-model-b' } },
      { scope },
    );
    expect(changed.options?.visualDirectionFingerprint).not.toBe(
      routed.options?.visualDirectionFingerprint,
    );
    expect(chat.chat).toHaveBeenCalledTimes(3);
    expect(changed.options?.outline).toEqual(input.options.outline);
  });

  it('allocates artwork across the whole deck using learned style before compiling batches', async () => {
    const content = port();
    const direction = {
      illustrationStyle: '统一主模板的水墨肌理与线条',
      continuityRules: ['同一主色、文字可编辑'],
      slides: Array.from({ length: 18 }, (_, index) => ({
        slideId: `slide-${index + 1}`,
        strategy: [0, 8, 16].includes(index) ? 'generate' : 'native',
        reason: '依据信息表达选择工具',
        priority: index,
        composition: '数据在左，素材在右；完整保留事实',
        capabilityIds: [],
        ...([0, 8, 16].includes(index) ? { visualBrief: '解释该页真实应用场景的原创插画' } : {}),
      })),
    };
    const chat = {
      ...content,
      chat: vi.fn<GLMMultimodalChatPort['chat']>(async (request, context) =>
        request.messages[0].content?.toString().includes('你是整份PPT')
          ? {
              choices: [
                { index: 0, message: { role: 'assistant', content: JSON.stringify(direction) } },
              ],
              created: 1,
              id: 'direction',
              model: 'test',
            }
          : content.chat(request, context),
      ),
    };
    const input = {
      notebookId: 'n',
      title: '自主选材报告',
      sourceVersionIds: [],
      slideCount: 18,
      options: {
        outline: Array.from({ length: 18 }, (_, i) => ({
          title: `内容${i + 1}`,
          keyPoints: ['真实事实'],
        })),
        deckVisualSystem: { id: 'shared-master' },
        learnedCapabilities: { capsules: [], composition: { styleCapsuleId: 'primary' } },
      },
    };
    const compiler = createPresentationContentCompiler(chat, 18, {
      maxRasterVisuals: 2,
      imageGenerationAvailable: true,
    });
    const prepared = await compiler.prepareVisualDirection!(input, { scope });
    const result = await compiler.compile(prepared, { scope });
    expect(chat.chat).toHaveBeenCalledTimes(6);
    expect(
      result.visualDirection?.slides
        .filter((page) => page.strategy === 'generate')
        .map((page) => page.slideId),
    ).toEqual(['slide-9', 'slide-17']);
    expect(
      result.slides
        .filter((page) => page.visuals?.some((v) => v.renderer === 'image'))
        .map((page) => page.slideId),
    ).toEqual(['slide-9', 'slide-17']);
    const request = JSON.parse(chat.chat.mock.calls[0][0].messages.at(-1)!.content as string);
    expect(request.deckVisualSystem.id).toBe('shared-master');
    expect(request.learnedCapabilities.composition.styleCapsuleId).toBe('primary');
    expect(result.visualDirection?.illustrationStyle).toContain('水墨');
    expect(await compiler.prepareVisualDirection!(prepared, { scope })).toBe(prepared);
    expect(chat.chat).toHaveBeenCalledTimes(6);
    expect(
      await compiler.prepareVisualDirection!(
        { ...prepared, prompt: '改为更强调应用场景的叙事' },
        { scope },
      ),
    ).not.toBe(prepared);
    expect(chat.chat).toHaveBeenCalledTimes(7);
  }, 15_000);

  it('honors disabled image generation even when the batch model proposes artwork', async () => {
    const chat = port();
    const result = await createPresentationContentCompiler(chat, 1, {
      imageGenerationAvailable: true,
    }).compile(
      {
        notebookId: 'n',
        title: '纯原生',
        sourceVersionIds: [],
        slideCount: 1,
        options: {
          outline: [{ title: '表格页' }],
          originalSlideNumbers: [12],
          visualEnrichment: { mode: 'off' },
        },
      },
      { scope },
    );
    expect(chat.chat).toHaveBeenCalledOnce();
    expect(result.slides[0].visuals).toEqual([]);
  });
  it('compiles 18 pages in small batches and restores their original identities and order', async () => {
    const chat = port(true);
    const outline = Array.from({ length: 18 }, (_, index) => ({
      title: `报告第${index + 1}页`,
      keyPoints: [`真实事实${index + 1}`],
    }));
    const result = await createPresentationContentCompiler(chat, 18, {
      maxRasterVisuals: 2,
    }).compile(
      {
        notebookId: 'n',
        title: '18页报告',
        sourceVersionIds: [],
        slideCount: 18,
        options: { outline, visualEnrichment: { mode: 'required', slideNumbers: [12, 15] } },
      },
      { scope },
    );
    expect(chat.chat).toHaveBeenCalledTimes(5);
    expect(
      chat.chat.mock.calls.map(
        ([request]) => JSON.parse(request.messages.at(-1)!.content as string).slideCount,
      ),
    ).toEqual([4, 4, 4, 4, 2]);
    expect(result.slides.map((slide) => slide.slideId)).toEqual(
      outline.map((_, index) => `slide-${index + 1}`),
    );
    expect(
      result.slides
        .filter((slide) => slide.visuals?.some((visual) => visual.renderer === 'image'))
        .map((slide) => slide.slideId),
    ).toEqual(['slide-12', 'slide-15']);
  }, 15_000);
});

it('binds exact approved math and provided figures across batches despite cross-page model guesses', async () => {
  const latex = String.raw`T=\frac{a}{b}`;
  const content = port();
  const chat = {
    ...content,
    chat: vi.fn<GLMMultimodalChatPort['chat']>(async (request) => {
      const p = JSON.parse(request.messages.at(-1)!.content as string);
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                slides: p.outline.map((page: any, i: number) => ({
                  slideId: `slide-${i + 1}`,
                  claim: page.title,
                  formulas: [
                    { id: 'guessed', latex: latex.replaceAll('\\', '\\\\'), fontSize: 28 },
                  ],
                  visualKind: 'source-figure',
                  visualReason: '不可靠的跨页猜测',
                  visuals: [
                    {
                      id: 'wrong-other-page',
                      kind: 'source-figure',
                      brief: '原图被分配错页',
                      required: true,
                    },
                    ...(i === p.outline.length - 1
                      ? [
                          {
                            id: 'invented-table',
                            kind: 'chart',
                            renderer: 'native',
                            fidelity: 'conceptual',
                            brief: '其他页表格与曲线待补',
                            required: true,
                          },
                        ]
                      : []),
                  ],
                })),
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
  const outline = ['封面', '观察图片', '两幅原图', '公式变量说明', '坐标曲线', '条件表格'].map(
    (title, i) => ({
      title,
      keyPoints: i === 3 ? [`定义：$${latex}$；a 与 b 表示已知变量`] : ['保留当前内容'],
    }),
  );
  const slots = [
    { slideId: 'slide-2', slotId: 'single', state: 'ready', assetRefs: [{ ref: 'original-a' }] },
    { slideId: 'slide-3', slotId: 'left', state: 'ready', assetRefs: [{ ref: 'original-b' }] },
    { slideId: 'slide-3', slotId: 'right', state: 'ready', assetRefs: [{ ref: 'original-c' }] },
    { slideId: 'slide-6', slotId: 'summary', state: 'ready', assetRefs: [{ ref: 'original-a' }] },
  ];
  const input = {
    title: '新主题',
    notebookId: 'n',
    sourceVersionIds: [],
    slideCount: 6,
    options: {
      outline,
      generatedImageSlots: slots,
      availableAssetRefs: ['original-a', 'original-b', 'original-c'],
      sourceDocumentVisuals: ['original-a', 'original-b', 'original-c'].map((ref) => ({
        ref,
        sourceId: 'provided-source',
      })),
    },
  };
  const result = await createPresentationContentCompiler(chat, 6, {
    imageGenerationAvailable: false,
  }).compile(input, { scope });
  expect(chat.chat).toHaveBeenCalledTimes(2);
  expect(
    result.slides.map((p) => p.visuals?.filter((v) => v.kind === 'source-figure').map((v) => v.id)),
  ).toEqual([[], ['original-a'], ['original-b', 'original-c'], [], [], ['original-a']]);
  expect(result.slides[3].formulas).toMatchObject([
    {
      id: 'approved-formula-1',
      latex,
      placement: 'slide',
      fontSize: 28,
      measurement: { fontSize: 28 },
    },
  ]);
  expect(result.slides[3].visuals).toEqual([]);
  const second = JSON.parse(chat.chat.mock.calls[1][0].messages.at(-1)!.content as string);
  expect(second.approvedImageBindings).toMatchObject([{ slideId: 'slide-2', slotId: 'summary' }]);
  const cached = readContentIntents({
    ...input,
    options: {
      ...input.options,
      contentIntents: {
        slides: result.slides.map((p) => ({
          ...p,
          visuals: [
            ...(p.visuals ?? []),
            { id: 'wrong', kind: 'source-figure', brief: 'wrong', required: true },
          ],
        })),
      },
    },
  });
  expect(
    cached.map((p) => p.visuals?.filter((v) => v.kind === 'source-figure').map((v) => v.id)),
  ).toEqual([[], ['original-a'], ['original-b', 'original-c'], [], [], ['original-a']]);
});

it('restores a provided image plus native content without allocating a second image from a cached mixed storyboard', () => {
  const input = {
    notebookId: 'test',
    title: '仪表读数',
    sourceVersionIds: [],
    options: {
      outline: [{ title: '原始照片和公式', keyPoints: [] }],
      generatedImageSlots: [
        { slideId: 'slide-1', state: 'ready', assetRefs: [{ ref: 'provided-picture' }] },
      ],
      sourceDocumentVisuals: [{ ref: 'provided-picture' }],
      contentIntents: {
        slides: [
          {
            slideId: 'slide-1',
            claim: '读数',
            formulas: [],
            visualKind: 'source-figure',
            visualReason: '照片和计算公式',
            visuals: [
              { id: 'provided-picture', kind: 'source-figure', required: true, brief: '照片' },
              {
                id: 'autonomous-visual',
                kind: 'illustration',
                renderer: 'image',
                required: true,
                brief: '同一张照片',
              },
            ],
          },
        ],
      },
      visualDirection: {
        illustrationStyle: '图文混排',
        continuityRules: ['保留图像'],
        slides: [
          {
            slideId: 'slide-1',
            strategy: 'mixed',
            imageSource: 'provided',
            reason: '照片和计算公式',
            priority: 50,
            visualBrief: '照片与公式同页',
            composition: '并排',
            capabilityIds: [],
          },
        ],
      },
    },
  };
  expect(readContentIntents(input)[0].visuals?.map((v) => v.kind)).toEqual(['source-figure']);
  input.options.visualDirection.slides[0].imageSource = 'both';
  expect(readContentIntents(input)[0].visuals?.map((v) => v.kind)).toEqual([
    'illustration',
    'source-figure',
  ]);
});
