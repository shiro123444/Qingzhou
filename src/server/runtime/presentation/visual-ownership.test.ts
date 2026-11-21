import { describe, expect, it } from 'vitest';
import { recordCanvasPlacement } from './canvas-command';
import { canvasAtoms } from '../../../../packages/utils/src/presentationAnnotation';
import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';

import type { PresentationSlidePlan } from '../../../../packages/runtime-contracts/src';
import { renderSemanticBlocks } from './semantic-blocks';
import {
  inspectVisualOccupancy,
  reconcileEmbeddedVisualAnnotations,
  reconcileNativeVisualAssets,
} from './visual-ownership';

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
  it('allows deliberate overlap only between manually arranged objects', async () => {
    const slide = await fixture();
    slide.metadata = { ...slide.metadata, canvasArrangements: [['atom-a', 'visual-1']] };
    const text =
      '<text data-canvas-object="atom-a" x="60" y="160" font-size="24">Selected title</text>';
    slide.svg = slide.svg.replace('</svg>', text + '</svg>');
    const collision = 'Text overlaps content block visual-1';
    expect(inspectVisualOccupancy(slide)).toContain(collision);
    expect(inspectVisualOccupancy(slide, new Map(), true)).not.toContain(collision);
    slide.svg = slide.svg.replace('</svg>', text.replace('atom-a', 'atom-b') + '</svg>');
    expect(inspectVisualOccupancy(slide, new Map(), true)).toContain(collision);
  });

  it('retains a dropped title over a diagram across retries and still flags unrelated collisions', async () => {
    const slide = await fixture();
    const label = '<text x="65" y="155" font-size="24">Dropped title</text>';
    slide.svg = slide.svg.replace('</svg>', label + '</svg>');
    const index = canvasAtoms(parseString(slide.svg).documentElement).findIndex(
      (el) => el.textContent === 'Dropped title',
    );
    const id = 'svg:' + index;
    slide.metadata = { ...slide.metadata, canvasSelection: { requestId: 'drop', ids: [id] } };
    expect(recordCanvasPlacement(slide, 'other', [id])).toBe(slide);
    const placed = recordCanvasPlacement(slide, 'drop', [id]);
    expect(recordCanvasPlacement(placed, 'drop', [id])).toBe(placed);
    const issue = 'Text overlaps content block visual-1';
    expect(inspectVisualOccupancy(placed, new Map(), true)).not.toContain(issue);
    expect(inspectVisualOccupancy(placed)).toContain(issue);
    const unrelated = {
      ...placed,
      svg: placed.svg.replace('</svg>', label.replace('Dropped', 'Other') + '</svg>'),
    };
    expect(inspectVisualOccupancy(unrelated, new Map(), true)).toContain(issue);
  });

  it('detects translated multiline card labels over a native diagram', async () => {
    const slide = await fixture();
    slide.svg = slide.svg.replace(
      '</svg>',
      '<g transform="translate(41 101)"><text x="20" y="60" font-size="24"><tspan x="20" dy="0">重复卡片标题</tspan><tspan x="20" dy="30">重复说明</tspan></text></g></svg>',
    );
    expect(inspectVisualOccupancy(slide)).toContain('Text overlaps content block visual-1');
    const moved = { ...slide, svg: slide.svg.replace('translate(41 101)', 'translate(41 420)') };
    expect(inspectVisualOccupancy(moved)).not.toContain('Text overlaps content block visual-1');
  });
  it('removes an embedded diagram overlay while retaining its original image and slide text', () => {
    const slide: PresentationSlidePlan = {
      slideId: 'slide-6',
      order: 6,
      svg: `<svg viewBox="0 0 960 540"><image href="${ref}"/><text>标题</text><g data-asset-annotations="visual-1"><text>重复标签</text></g></svg>`,
      metadata: {
        visualRequirements: [
          {
            id: 'visual-1',
            kind: 'scientific-diagram',
            renderer: 'image',
            fidelity: 'conceptual',
            brief: '课程知识地图',
            required: true,
            annotationMode: 'embedded',
          },
        ],
      },
    };
    const repaired = reconcileEmbeddedVisualAnnotations(slide);
    expect(repaired.svg).toContain(ref);
    expect(repaired.svg).toContain('标题');
    expect(repaired.svg).not.toContain('重复标签');
    expect(reconcileEmbeddedVisualAnnotations(repaired)).toBe(repaired);
  });

  it('does not reflow text sitting in an empty contain margin', () => {
    const slide: PresentationSlidePlan = {
      slideId: 'slide-6',
      order: 6,
      svg: `<svg viewBox="0 0 960 540"><image href="${ref}" x="100" y="120" width="800" height="300" preserveAspectRatio="xMidYMid meet"/><text x="120" y="200" font-size="24">说明</text></svg>`,
      metadata: {
        visualAssets: [
          { visualId: 'visual-1', kind: 'scientific-diagram', ref, origin: 'generated' },
        ],
      },
    };
    expect(inspectVisualOccupancy(slide)).toContain('Text overlaps image visual-1');
    expect(inspectVisualOccupancy(slide, new Map([[ref, { width: 100, height: 100 }]]))).toEqual(
      [],
    );
    expect(
      inspectVisualOccupancy(
        { ...slide, svg: slide.svg.replace('x="120" y="200"', 'x="480" y="200"') },
        new Map([[ref, { width: 100, height: 100 }]]),
      ),
    ).toContain('Text overlaps image visual-1');
  });
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
