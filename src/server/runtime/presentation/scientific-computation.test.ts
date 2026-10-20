import { describe, expect, it } from 'vitest';

import { isNativeVisual, isRasterVisual } from './content-intent';
import { computeScientificPlot } from './scientific-computation';
import {
  renderScientificDiagram,
  renderSemanticBlocks,
  semanticBlockSchema,
} from './semantic-blocks';

describe('reproducible scientific visuals', () => {
  const recipe = {
    type: 'quadratic' as const,
    a: 1,
    b: 20,
    levels: [10, 20],
    start: [-3, 1] as [number, number],
    learningRate: 0.08,
    steps: 12,
    methods: ['gradient' as const],
  };
  it('computes every level-set point and GD step instead of accepting imagined trajectories', () => {
    const plot = computeScientificPlot(recipe);
    for (const [i, level] of recipe.levels.entries())
      for (const [x, y] of plot.series[i].points)
        expect((x * x + 20 * y * y) / 2).toBeCloseTo(level, 9);
    const points = plot.series.at(-1)!.points;
    expect(points[1][0]).toBeCloseTo(-2.76);
    expect(points[1][1]).toBeCloseTo(-0.6);
    for (let i = 1; i < points.length; i++) {
      expect(points[i][0]).toBeCloseTo(points[i - 1][0] * 0.92);
      expect(points[i][1]).toBeCloseTo(points[i - 1][1] * -0.6);
    }
    expect(plot.equalAspect).toBe(true);
  });
  it('computes Taylor approximations with matching value and derivatives', () => {
    const plot = computeScientificPlot({
      type: 'taylor',
      coefficients: [0, 0, 1],
      at: 1,
      xRange: [0, 2],
    });
    expect(plot.series.map((series) => series.label)).toEqual(['f(x)', 'T₁(x)']);
    plot.series[0].points.forEach(([x, y]) => expect(y).toBeCloseTo(x * x, 12));
    expect(plot.series[1].points[60]).toEqual([1, 1]);
  });
  it('uses image generation for conceptual scientific diagrams independently of their kind', () => {
    const visual = {
      id: 'mechanism',
      kind: 'scientific-diagram' as const,
      renderer: 'image' as const,
      brief: 'Draw the mechanism',
      required: true,
    };
    expect(isRasterVisual(visual)).toBe(true);
    expect(isNativeVisual(visual)).toBe(false);
  });
  it('renders computed plots with experiment parameters, and graphs without a fake-data disclaimer', () => {
    const base = {
      id: 'test',
      kind: 'scientific-diagram',
      title: '实验',
      rect: { x: 0, y: 0, width: 650, height: 420 },
      provenance: { kind: 'illustrative' },
    };
    const block = semanticBlockSchema.parse({ ...base, spec: recipe });
    if (block.kind !== 'scientific-diagram') throw new Error('wrong kind');
    expect(renderScientificDiagram(block)).toContain('η=0.08');
    expect(renderScientificDiagram(block)).not.toContain('非实测');
    const graph = semanticBlockSchema.parse({
      ...base,
      spec: { type: 'graph', nodes: [{ id: 'a', label: '输入', x: 0.5, y: 0.5 }], edges: [] },
    });
    if (graph.kind !== 'scientific-diagram') throw new Error('wrong kind');
    expect(renderScientificDiagram(graph)).not.toContain('示意图');
  });
  it('does not let a computed requirement use invented raw points', async () => {
    await expect(
      renderSemanticBlocks(
        '<svg viewBox="0 0 960 540"><g data-content-id="test"/></svg>',
        [
          {
            id: 'test',
            kind: 'scientific-diagram',
            title: 'test',
            rect: { x: 0, y: 0, width: 600, height: 400 },
            provenance: { kind: 'illustrative' },
            spec: {
              type: 'plot',
              xRange: [0, 1],
              yRange: [0, 1],
              xLabel: 'x',
              yLabel: 'y',
              series: [
                {
                  label: 'claim',
                  points: [
                    [0, 0],
                    [1, 1],
                  ],
                },
              ],
            },
          },
        ],
        {
          slideId: 'slide-1',
          claim: 'test',
          formulas: [],
          visualKind: 'scientific-diagram',
          visualReason: 'test',
          visuals: [
            {
              id: 'test',
              kind: 'scientific-diagram',
              renderer: 'native',
              fidelity: 'computed',
              required: true,
              brief: 'computed',
            },
          ],
        },
      ),
    ).rejects.toThrow('reproducible');
  });
  it('keeps axes aligned with data when equal aspect leaves horizontal margins', () => {
    const block = semanticBlockSchema.parse({
      id: 'axes',
      kind: 'scientific-diagram',
      title: 'Vector',
      rect: { x: 0, y: 0, width: 650, height: 420 },
      provenance: { kind: 'illustrative' },
      spec: {
        type: 'plot',
        equalAspect: true,
        xRange: [0, 1],
        yRange: [0, 1],
        xLabel: 'x',
        yLabel: 'y',
        series: [
          {
            label: 'direction',
            points: [
              [0, 0],
              [1, 1],
            ],
            arrowEnd: true,
          },
        ],
      },
    });
    if (block.kind !== 'scientific-diagram') throw new Error('wrong kind');
    const svg = renderScientificDiagram(block);
    const axes = svg.match(/d="M ([\d.]+) ([\d.]+) V ([\d.]+) H ([\d.]+)"/)!;
    const points = svg
      .match(/<polyline points="([\d., ]+)"/)![1]
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(points[0]).toEqual([Number(axes[1]), Number(axes[3])]);
    expect(points[1]).toEqual([Number(axes[4]), Number(axes[2])]);
    expect(points[1][0] - points[0][0]).toBeCloseTo(points[0][1] - points[1][1]);
  });
});
