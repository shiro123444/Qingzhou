import { describe, expect, it } from 'vitest';
import { bindApprovedGraphDirections } from './approved-graph-directions';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

const graph = {
  id: 'links',
  kind: 'scientific-diagram',
  title: '分工',
  rect: { x: 0, y: 0, width: 864, height: 240 },
  provenance: { kind: 'illustrative' },
  spec: {
    type: 'graph',
    style: { fontSize: 24, nodeFill: 'none', nodeStroke: 'none' },
    nodes: [
      { id: 'desk', label: '前台·当晚', x: 0.2, y: 0.22 },
      { id: 'runner', label: '协调员·当晚', x: 0.8, y: 0.22 },
      { id: 'office', label: '办公室·次日', x: 0.5, y: 0.8 },
    ],
    edges: [
      { from: 'desk', to: 'runner', label: '协作' },
      { from: 'desk', to: 'office', label: '汇报' },
      { from: 'runner', to: 'office', label: '汇报' },
    ],
  },
};

describe('explicit reciprocal graph directions', () => {
  it('keeps a reciprocal relation on its single labelled connector with arrowheads at both ends', () => {
    const content = ['交接顺序：当晚前台↔协调员协作，次日由办公室汇总'];
    const blocks = bindApprovedGraphDirections([graph], content) as [typeof graph];
    expect(blocks[0].spec.edges).toEqual([
      { ...graph.spec.edges[0], bidirectional: true },
      ...graph.spec.edges.slice(1),
    ]);
    expect(bindApprovedGraphDirections(blocks, content)).toEqual(blocks);
    expect(bindApprovedGraphDirections([graph], ['前台与协调员之间采用双向箭头'])).toEqual(blocks);
    const render = (raw: unknown) => {
      const block = semanticBlockSchema.parse(raw);
      if (block.kind !== 'scientific-diagram') throw new Error('expected graph');
      return renderScientificDiagram(block);
    };
    const pathCount = (svg: string) => [...svg.matchAll(/<path /gu)].length;
    expect(pathCount(render(blocks[0]))).toBe(pathCount(render(graph)) + 1);
    expect(render(blocks[0]).match(/>协作</gu)).toHaveLength(1);
  });
  it.each([
    '前台与协调员协作',
    '前台→协调员',
    '不要使用前台↔协调员',
    '不成立：前台↔协调员',
    '前台↔外部单位',
  ])('preserves original edge directions for %s', (point) => {
    expect(bindApprovedGraphDirections([graph], [point])).toEqual([graph]);
  });
  it('leaves ambiguous roles and separate return edges untouched', () => {
    const ambiguous = {
      ...graph,
      spec: {
        ...graph.spec,
        nodes: [...graph.spec.nodes, { id: 'second', label: '前台·次日', x: 0.2, y: 0.8 }],
      },
    };
    expect(bindApprovedGraphDirections([ambiguous], ['前台↔协调员'])).toEqual([ambiguous]);
    const directed = {
      ...graph,
      spec: {
        ...graph.spec,
        edges: [...graph.spec.edges, { from: 'runner', to: 'desk', label: '确认' }],
      },
    };
    expect(bindApprovedGraphDirections([directed], ['前台↔协调员'])).toEqual([directed]);
  });
});
