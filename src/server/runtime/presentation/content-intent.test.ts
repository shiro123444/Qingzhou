import { describe, expect, it, vi } from 'vitest';

import { createPresentationContentCompiler } from './content-intent';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';

const scope = { userId: 'owner', sessionId: 'session' };
function port() {
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async (request) => {
    const payload = JSON.parse(request.messages.at(-1)!.content as string);
    const slides = Array.from({ length: payload.slideCount }, (_, index) => ({
      slideId: `slide-${index + 1}`,
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
  it('compiles 18 pages in small batches and restores their original identities and order', async () => {
    const chat = port();
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
