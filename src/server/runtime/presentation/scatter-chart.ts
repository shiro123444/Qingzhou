import { graphLabelLines } from './scientific-graph-layout';
import type { SemanticBlock } from './semantic-blocks';

type Diagram = Extract<SemanticBlock, { kind: 'scientific-diagram' }>;
type PlotSpec = Extract<Diagram['spec'], { type: 'plot' }>;
export type ScatterBlock = Diagram & { spec: PlotSpec };

export const plotPalette = ['#2563eb', '#dc2626', '#059669', '#7c3aed', '#b45309', '#0891b2'];

export function isEditableScatter(block: SemanticBlock): block is ScatterBlock {
  return (
    block.kind === 'scientific-diagram' &&
    block.spec.type === 'plot' &&
    !block.spec.equalAspect &&
    block.spec.series.every((series) => series.points && !series.arrowEnd)
  );
}

export function plotFrame(
  series: readonly { label: string }[],
  width: number,
  height: number,
  captionLines: number,
) {
  const left = 48;
  const right = width - 28;
  const bottom = height - 68 - Math.max(0, captionLines - 1) * 20;
  const legendLines = series.map(({ label }) => graphLabelLines(label, width - 84));
  const legendHeight = legendLines.reduce((rows, lines) => rows + lines.length, 0) * 20;
  const withLegend = bottom - (28 + legendHeight) >= 48;
  return { bottom, left, legendLines, right, top: withLegend ? 28 + legendHeight : 28, withLegend };
}

export function replaceScatterPoints(block: ScatterBlock, points: [number, number][][]) {
  if (points.length !== block.spec.series.length) throw new Error('图表数据列数与原图不一致');
  const range = (axis: 0 | 1, previous: [number, number]): [number, number] => {
    const values = points.flatMap((series) => series.map((point) => point[axis]));
    return [Math.min(previous[0], ...values), Math.max(previous[1], ...values)];
  };
  return {
    ...block,
    spec: {
      ...block.spec,
      xRange: range(0, block.spec.xRange),
      yRange: range(1, block.spec.yRange),
      series: block.spec.series.map((series, index) => ({ ...series, points: points[index] })),
    },
  };
}
