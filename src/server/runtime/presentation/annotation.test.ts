import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  PresentationMessageInput,
  PresentationPlan,
} from '../../../../packages/runtime-contracts/src';
import {
  annotationElements,
  mergeAnnotationElements,
} from '../../../../packages/utils/src/presentationAnnotation';
import { reviseAnnotation, validateAnnotation } from './annotation';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><defs><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs><!-- retain formatting --><rect width="960" height="540" fill="#fff"/><g transform="translate(20 30)"><text x="12" y="32" font-size="24">旧标题<tspan>！</tspan></text></g><image href="/api/runtime/presentation/artifacts/image-owned?raw=true" x="300" y="100" width="200" height="200"/></svg>';
const plan: PresentationPlan = {
  planId: 'plan',
  title: 'Example',
  aspectRatio: '16:9',
  sourceVersionIds: [],
  slides: [
    {
      slideId: 'one',
      order: 1,
      svg,
      notes: 'Keep my notes',
      metadata: { title: 'Original', generatedAssetRefs: ['image-owned'] },
    },
    { slideId: 'two', order: 2, svg },
  ],
};
const message: PresentationMessageInput = {
  requestId: 'pin-1',
  content: '改成新标题',
  target: { type: 'slide', slideNumber: 1 },
  annotation: {
    slideId: 'one',
    expectedVersionId: 'v1',
    baseSvgHash: createHash('sha256').update(svg).digest('hex'),
    elementIndices: [1],
    region: { x: 0.03, y: 0.05, width: 0.2, height: 0.1 },
  },
};
describe('slide annotations', () => {
  it('indexes visible elements, keeping text spans atomic and definitions excluded', () => {
    expect(annotationElements(svg).map((e) => e.tag)).toEqual(['rect', 'text', 'image']);
    expect(annotationElements(svg)[1].source).toContain('<tspan>！</tspan>');
  });
  it('splices only authorized bytes and preserves notes, images and other pages', async () => {
    const replacement = '<text x="12" y="32" font-size="24">新标题</text>';
    const chat = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ patches: [{ index: 1, svg: replacement }] }) } },
      ],
    });
    const result = await reviseAnnotation(
      plan,
      message,
      { chat, manifest: { model: 'test' } } as any,
      { userId: 'u', sessionId: 's' },
    );
    expect(result.slides[0].svg).toBe(svg.replace(annotationElements(svg)[1].source, replacement));
    expect(result.slides[0].notes).toBe(plan.slides[0].notes);
    expect(result.slides[0].metadata).toEqual(plan.slides[0].metadata);
    expect(result.slides[1]).toEqual(plan.slides[1]);
  });
  it('rejects stale pages, bad selections and out-of-range coordinates', () => {
    expect(() =>
      validateAnnotation(
        { ...plan, slides: [{ ...plan.slides[0], svg: svg.replace('旧标题', '已改') }] },
        message,
      ),
    ).toThrow('重新标注');
    for (const changes of [
      { elementIndices: [99] },
      { elementIndices: [1, 1] },
      { region: { x: 0.9, y: 0, width: 0.3, height: 0.2 } },
    ])
      expect(() =>
        validateAnnotation(plan, {
          ...message,
          annotation: { ...message.annotation!, ...changes },
        }),
      ).toThrow();
  });
  it('rejects unselected edits, global styles, scripts and unknown image references', async () => {
    expect(() =>
      mergeAnnotationElements(svg, [1], [{ index: 0, svg: '<rect width="20" height="20"/>' }]),
    ).toThrow('unselected');
    for (const patch of [
      '<style>text{fill:red}</style><text>x</text>',
      '<text onclick="alert(1)">x</text>',
      '<script/>',
      '<image href="https://evil.test/a"/>',
    ])
      expect(() => mergeAnnotationElements(svg, [1], [{ index: 1, svg: patch }])).toThrow();
    const chat = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patches: [
                {
                  index: 1,
                  svg: '<image href="/api/runtime/presentation/artifacts/stolen?raw=true" width="20" height="20"/>',
                },
              ],
            }),
          },
        },
      ],
    });
    await expect(
      reviseAnnotation(plan, message, { chat, manifest: { model: 'test' } } as any, {
        userId: 'u',
        sessionId: 's',
      }),
    ).rejects.toThrow('unowned');
  });
  it('allows a patch-local clip path while rejecting non-local URL references', () => {
    const imageIndex = 2;
    const clipped =
      '<g><defs><clipPath id="annotation-clip"><path d="M300 100h180q20 0 20 20v160q0 20-20 20H300z"/></clipPath></defs><image href="/api/runtime/presentation/artifacts/image-owned?raw=true" x="300" y="100" width="200" height="200" clip-path="url(#annotation-clip)"/></g>';
    expect(
      mergeAnnotationElements(svg, [imageIndex], [{ index: imageIndex, svg: clipped }]),
    ).toContain('clip-path="url(#annotation-clip)"');
    expect(() =>
      mergeAnnotationElements(
        svg,
        [imageIndex],
        [
          {
            index: imageIndex,
            svg: '<image href="/api/runtime/presentation/artifacts/image-owned?raw=true" clip-path="url(#missing)"/>',
          },
        ],
      ),
    ).toThrow('Unsafe annotation patch');
  });
});
