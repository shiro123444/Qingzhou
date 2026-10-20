import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { pngRenderSchema, renderSemanticPng } from './png-renderer';

const formula = {
  id: 'png-formula',
  kind: 'formula' as const,
  latex: 'x^2+y^2=z^2',
  rect: { x: 20, y: 30, width: 640, height: 160 },
  display: true,
  color: '#172554',
  fontSize: 40,
};

describe('semantic PNG rendering', () => {
  it('renders real PNG pixels with the requested canvas and transparent background', async () => {
    const result = await renderSemanticPng({
      block: formula,
      scale: 2,
      background: '#FFFFFF',
      transparent: true,
    });
    expect([...result.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 1280, height: 320, hasAlpha: true });
    const stats = await sharp(result.bytes).stats();
    expect(stats.channels.at(-1)!.min).toBe(0);
    expect(stats.channels.at(-1)!.max).toBe(255);
    expect(result.source).toMatchObject({ kind: 'formula', latex: formula.latex });
  });

  it('rejects oversized canvases and raw SVG injection before rendering', async () => {
    expect(
      pngRenderSchema.safeParse({ block: { ...formula, rect: { ...formula.rect, width: 5000 } } })
        .success,
    ).toBe(false);
    expect(
      pngRenderSchema.safeParse({
        block: formula,
        svg: '<svg><image href="file:///private"/></svg>',
      }).success,
    ).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderSemanticPng(
        { block: formula, scale: 1, background: '#FFFFFF', transparent: false },
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
