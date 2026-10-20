import { describe, expect, it, vi } from 'vitest';

import { createPresentationContentCompiler } from './content-intent';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';

const scope = { userId: 'owner', sessionId: 'session' };
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
