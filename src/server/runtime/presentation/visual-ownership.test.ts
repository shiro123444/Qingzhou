import { describe, expect, it } from 'vitest';

import type { PresentationSlidePlan } from '../../../../packages/runtime-contracts/src';
import { renderSemanticBlocks } from './semantic-blocks';
import { inspectVisualOccupancy, reconcileNativeVisualAssets } from './visual-ownership';

const ref = '/api/runtime/presentation/artifacts/old-chart';
const diagram = {
  id: 'visual-1',
  kind: 'scientific-diagram',
  title: 'Comparison',
  rect: { x: 40, y: 100, width: 400, height: 300 },
  provenance: { kind: 'illustrative' },
  spec: { type: 'graph', nodes: [{ id: 'one', label: 'One', x: 0.5, y: 0.5 }], edges: [] },
};
async function fixture(): Promise<PresentationSlidePlan> {
  const rendered = await renderSemanticBlocks(
    `<svg viewBox="0 0 960 540"><g data-content-id="visual-1"/><text x="500" y="80" font-size="24">Explanation</text><image href="${ref}?raw=true" x="480" y="120" width="400" height="300"/></svg>`,
    [diagram],
  );
  return {
    slideId: 'slide-13',
    order: 13,
    svg: rendered.svg,
    metadata: {
      contentBlocks: rendered.blocks,
      visualRequirements: [
        { id: 'visual-1', kind: 'chart', renderer: 'native', brief: 'Comparison', required: true },
      ],
      visualAssets: [{ visualId: 'visual-1', kind: 'chart', origin: 'generated', ref }],
      generatedAssetRefs: ['old-chart'],
    },
  };
}

describe('visual representation ownership', () => {
  it('retires the old bitmap after a native replacement and is idempotent', async () => {
    const slide = await fixture();
    const next = reconcileNativeVisualAssets(slide);
    expect(next.svg).not.toContain('<image');
    expect(next.svg).toContain('data-scientific-diagram="visual-1"');
    expect(next.metadata?.visualAssets).toEqual([]);
    expect(next.metadata?.generatedAssetRefs).toEqual([]);
    expect(reconcileNativeVisualAssets(next)).toEqual(next);
    expect(slide.svg).toContain('<image');
  });
  it('keeps an asset when native content was never rendered or another visual still uses it', async () => {
    const slide = await fixture();
    const unrendered = {
      ...slide,
      svg: slide.svg.replace('data-scientific-diagram="visual-1"', ''),
    };
    expect(reconcileNativeVisualAssets(unrendered)).toEqual(unrendered);
    const shared = {
      ...slide,
      metadata: {
        ...slide.metadata,
        visualAssets: [
          ...(slide.metadata!.visualAssets as object[]),
          { visualId: 'visual-2', kind: 'scientific-illustration', origin: 'generated', ref },
        ],
      },
    };
    expect(reconcileNativeVisualAssets(shared).svg).toContain('<image');
    expect(reconcileNativeVisualAssets(shared).metadata?.visualAssets).toEqual([
      expect.objectContaining({ visualId: 'visual-2' }),
    ]);
  });
  it('detects a distinct image intruding on native content and text intruding on its region', async () => {
    const slide = await fixture();
    slide.svg = slide.svg
      .replace('x="480" y="120"', 'x="80" y="120"')
      .replace('x="500" y="80"', 'x="100" y="160"');
    expect(inspectVisualOccupancy(slide)).toEqual(
      expect.arrayContaining([
        'Image visual-1 overlaps content block visual-1',
        'Text overlaps content block visual-1',
      ]),
    );
    expect(inspectVisualOccupancy(await fixture())).toEqual([]);
  });
});
