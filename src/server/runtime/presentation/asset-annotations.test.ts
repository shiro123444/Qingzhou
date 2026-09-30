import { describe, expect, it } from 'vitest';

import {
  assetAnnotationSchema,
  assetAnnotationsSchema,
  assetPlacementBox,
  overlayAssetAnnotations,
  renderAssetAnnotations,
  truncateAnnotationLabel,
} from './asset-annotations';
import { visualRequirementSchema } from './content-intent';

const box = { height: 300, width: 400, x: 500, y: 120 };

describe('asset annotation contract', () => {
  it('accepts arrows, guides and labels in asset-local coordinates', () => {
    const annotations = [
      {
        from: { x: 0.2, y: 0.8 },
        label: '−∇f(x*)',
        to: { x: 0.6, y: 0.4 },
        type: 'vector' as const,
      },
      { at: { x: 0.5, y: 0.5 }, text: '切点 x*', type: 'label' as const },
      { from: { x: 0, y: 1 }, to: { x: 1, y: 1 }, type: 'guide' as const },
    ];
    for (const annotation of annotations)
      expect(assetAnnotationSchema.safeParse(annotation).success).toBe(true);
  });

  it('rejects pixel coordinates, degenerate directions and over-long labels', () => {
    expect(
      assetAnnotationSchema.safeParse({
        from: { x: 120, y: 80 },
        to: { x: 400, y: 200 },
        type: 'vector',
      }).success,
    ).toBe(false);
    expect(
      assetAnnotationSchema.safeParse({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.5, y: 0.5 },
        type: 'vector',
      }).success,
    ).toBe(false);
    expect(
      assetAnnotationSchema.safeParse({
        at: { x: 0.5, y: 0.5 },
        text: '这是一个远超过二十四个字符上限的长标签，用来验证契约会拒绝它',
        type: 'label',
      }).success,
    ).toBe(false);
    expect(
      assetAnnotationSchema.safeParse({
        at: { x: 0.5, y: 0.5 },
        text: 'ok',
        type: 'label',
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it('rejects a degenerate guide', () => {
    expect(
      assetAnnotationSchema.safeParse({
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.105, y: 0.1 },
        type: 'guide',
      }).success,
    ).toBe(false);
  });
  it('carries annotations through the compiled visual requirement contract', () => {
    const visual = visualRequirementSchema.parse({
      id: 'visual-1',
      kind: 'scientific-diagram',
      brief: '受力几何图',
      required: true,
      renderer: 'image',
      annotations: [
        { type: 'vector', from: { x: 0.1, y: 0.9 }, to: { x: 0.8, y: 0.2 }, label: '−∇f' },
        { type: 'label', at: { x: 0.5, y: 0.1 }, text: '切点 x*' },
      ],
    });
    expect(visual.annotations).toHaveLength(2);
    expect(visual.annotations?.[0]).toMatchObject({ label: '−∇f', type: 'vector' });
    expect(visual.annotations?.[1]).toMatchObject({ anchor: 'middle', text: '切点 x*' });
  });
});

describe('asset annotation rendering', () => {
  it('projects arrows into page pixels with an arrowhead and a label', () => {
    const markup = renderAssetAnnotations(
      [
        {
          from: { x: 0, y: 1 },
          label: '∇g',
          to: { x: 1, y: 0.5 },
          type: 'vector',
        },
      ],
      box,
      'visual-1',
    );
    // from = (500, 420), to = (900, 270) for this box
    expect(markup).toContain('data-asset-annotations="visual-1"');
    expect(markup).toContain('M 500 420 L 900 270');
    expect(markup).toContain('fill="none" stroke="#dc2626" stroke-width="3"');
    expect(markup).toContain('∇g');
    expect(markup.match(/<path/gu)).toHaveLength(2);
  });

  it('keeps labels inside their own artwork box', () => {
    const markup = renderAssetAnnotations(
      [{ at: { x: 0, y: 0 }, text: '顶点', type: 'label' }],
      box,
      'visual-2',
    );
    const x = Number(/<text x="([\d.-]+)"/u.exec(markup)![1]);
    expect(x).toBeGreaterThanOrEqual(box.x + 4);
    expect(x).toBeLessThanOrEqual(box.x + box.width);
  });

  it('draws guides dashed and skips empty annotation lists', () => {
    expect(
      renderAssetAnnotations(
        [{ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, type: 'guide' }],
        box,
        'visual-3',
      ),
    ).toContain('stroke-dasharray="6 5"');
    expect(renderAssetAnnotations([], box, 'visual-4')).toBe('');
  });

  it('maps a placement to the same page box the composer uses', () => {
    expect(
      assetPlacementBox([0, 0, 960, 540], { height: 0.5, width: 0.5, x: 0.5, y: 0.25 }),
    ).toEqual({ height: 270, width: 480, x: 480, y: 135 });
  });

  it('overlays annotations only for placed assets and leaves other pages untouched', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><image href="/api/runtime/presentation/artifacts/a" x="480" y="135" width="480" height="270"/></svg>';
    const overlaid = overlayAssetAnnotations(
      svg,
      [0, 0, 960, 540],
      [
        {
          annotations: [{ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, type: 'vector' }],
          layout: { height: 0.5, width: 0.5, x: 0.5, y: 0.25 },
          visualId: 'visual-1',
        },
      ],
    );
    expect(overlaid).toContain('data-asset-annotations="visual-1"');
    expect(overlaid.indexOf('data-asset-annotations')).toBeGreaterThan(overlaid.indexOf('<image'));
    expect(overlaid.endsWith('</svg>')).toBe(true);

    expect(overlayAssetAnnotations(svg, [0, 0, 960, 540], [])).toBe(svg);
    expect(
      overlayAssetAnnotations(
        svg,
        [0, 0, 960, 540],
        [{ annotations: [{ at: { x: 0.5, y: 0.5 }, text: 'x', type: 'label' }], visualId: 'v' }],
      ),
    ).toBe(svg);
  });
});

describe('asset annotation leniency', () => {
  it('accepts the label alias, percentages and center anchors the model actually emits', () => {
    const parsed = assetAnnotationsSchema.parse([
      { anchor: 'center', at: { x: 50, y: 12 }, label: '支撑超平面', type: 'label' },
      { from: { x: 20, y: 80 }, label: '−∇f(x*)', to: { x: 70, y: 30 }, type: 'vector' },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({
      anchor: 'middle',
      at: { x: 0.5, y: 0.12 },
      text: '支撑超平面',
      type: 'label',
    });
    expect(parsed![1]).toMatchObject({
      from: { x: 0.2, y: 0.8 },
      label: '−∇f(x*)',
      to: { x: 0.7, y: 0.3 },
      type: 'vector',
    });
  });

  it('drops unusable entries and truncates long labels instead of failing the page', () => {
    const parsed = assetAnnotationsSchema.parse([
      { at: { x: 0.5, y: 0.5 }, text: 'A'.repeat(30), type: 'label' },
      { from: { x: 1200, y: 800 }, to: { x: 400, y: 200 }, type: 'vector' },
      'nonsense',
      { from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 }, type: 'vector' },
      { at: { x: 0.2, y: 0.3 }, label: '还能用', type: 'label' },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toMatchObject({ text: 'A'.repeat(24), type: 'label' });
    expect(parsed![1]).toMatchObject({ at: { x: 0.2, y: 0.3 }, text: '还能用', type: 'label' });
  });

  it('cuts an over-long label at a readable boundary instead of mid-token', () => {
    // The real deck shipped "支撑超平面 (Supporting Hyperp" and "零对偶间隙 (Ze" before this rule.
    expect(truncateAnnotationLabel('支撑超平面 (Supporting Hyperplane)')).toBe('支撑超平面');
    // The model cut this one itself, so the half-open group is dropped even though it fits.
    expect(truncateAnnotationLabel('零对偶间隙 (Ze')).toBe('零对偶间隙');
    expect(truncateAnnotationLabel('零对偶间隙 (Zero Duality Gap)')).toBe(
      '零对偶间隙 (Zero Duality Gap)',
    );
    expect(truncateAnnotationLabel('Supporting Hyperplane of the optimal dual point')).toBe(
      'Supporting Hyperplane',
    );
    // A gloss that fits inside the cap is kept whole; one too long for it is dropped rather than cut.
    expect(truncateAnnotationLabel('凸优化 (Convex Opt) 与最优性条件讨论')).toBe(
      '凸优化 (Convex Opt)',
    );
    expect(truncateAnnotationLabel('凸优化 (Convex Optimization) 与最优性条件')).toBe('凸优化');
    expect(truncateAnnotationLabel('切点 x*')).toBe('切点 x*');
    // A single unbroken token has no boundary to prefer; a hard cut still beats dropping it.
    expect(truncateAnnotationLabel('A'.repeat(30))).toBe('A'.repeat(24));
  });

  it('renders a truncated label without a dangling parenthesis', () => {
    const parsed = assetAnnotationsSchema.parse([
      { at: { x: 0.5, y: 0.5 }, text: '支撑超平面 (Supporting Hyperplane)', type: 'label' },
    ]);
    const svg = renderAssetAnnotations(
      parsed!,
      { height: 300, width: 400, x: 0, y: 0 },
      'visual-1',
    );
    expect(svg).toContain('>支撑超平面<');
    expect(svg).not.toContain('Supporting');
  });

  it('caps the declared relations rather than rejecting the batch', () => {
    const parsed = assetAnnotationsSchema.parse(
      Array.from({ length: 12 }, (_, index) => ({
        at: { x: 0.5, y: index / 40 },
        text: `t${index}`,
        type: 'label',
      })),
    );
    expect(parsed).toHaveLength(8);
  });

  it('normalizes the label alias inside a compiled visual requirement instead of failing the deck', () => {
    const parsed = visualRequirementSchema.parse({
      annotations: [
        { at: { x: 50, y: 12 }, label: '支撑超平面', type: 'label' },
        { from: { x: 20, y: 80 }, label: '−∇f(x*)', to: { x: 70, y: 30 }, type: 'vector' },
      ],
      brief: 'Convex feasible set with a supporting hyperplane',
      id: 'visual-1',
      kind: 'scientific-diagram',
      renderer: 'image',
      required: true,
    });
    expect(parsed.annotations).toHaveLength(2);
    expect(renderAssetAnnotations(parsed.annotations!, box, 'visual-1')).toContain('支撑超平面');
    expect(renderAssetAnnotations(parsed.annotations!, box, 'visual-1')).toContain('−∇f(x*)');
  });
});
