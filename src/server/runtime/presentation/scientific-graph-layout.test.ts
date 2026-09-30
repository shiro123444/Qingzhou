import { describe, expect, it } from 'vitest';

import {
  graphLabelLines,
  layoutScientificGraph,
  minimumGraphLabelWidth,
} from './scientific-graph-layout';

describe('scientific graph layout', () => {
  it('keeps scientific Latin names intact when wrapping a mixed-script node', () => {
    expect(graphLabelLines('自适应AdamW', 70)).toEqual(['自适应', 'AdamW']);
  });
  it('fits a seven-node decision tree in a half slide without overlapping nodes or shrinking labels', () => {
    const spec = {
      nodes: [
        { id: 'root', label: '目标问题', x: 0.08, y: 0.48 },
        { id: 'convex', label: '凸优化问题', x: 0.38, y: 0.22 },
        { id: 'nonconvex', label: '大规模非凸', x: 0.38, y: 0.74 },
        { id: 'low', label: '精确内点法', x: 0.85, y: 0.1 },
        { id: 'mid', label: 'L-BFGS拟牛顿', x: 0.85, y: 0.34 },
        { id: 'high', label: '自适应SGD/Adam', x: 0.85, y: 0.62 },
        { id: 'distributed', label: '异步分布式优化', x: 0.85, y: 0.86 },
      ],
      edges: [
        { from: 'root', to: 'convex', label: '严格凸/强对偶' },
        { from: 'root', to: 'nonconvex', label: '深度非凸地形' },
        { from: 'convex', to: 'low', label: '小规模/高精度' },
        { from: 'convex', to: 'mid', label: '中维曲率逼近' },
        { from: 'nonconvex', to: 'high', label: '超高维随机梯度' },
        { from: 'nonconvex', to: 'distributed', label: '显存/通信受限' },
      ],
    };
    const result = layoutScientificGraph(spec, 450, 260);
    expect(result.horizontal).toBe(true);
    for (const node of result.positions.values()) {
      expect(node.lines.length).toBeLessThanOrEqual(2);
      expect(node.x - result.nodeWidth / 2).toBeGreaterThanOrEqual(0);
      expect(node.x + result.nodeWidth / 2).toBeLessThanOrEqual(450);
      expect(node.y + result.nodeHeight / 2).toBeLessThanOrEqual(232);
    }
    for (const edge of spec.edges) {
      const gap =
        result.positions.get(edge.to)!.x - result.positions.get(edge.from)!.x - result.nodeWidth;
      expect(graphLabelLines(edge.label, gap - 20).length).toBeLessThanOrEqual(2);
    }
  });

  it('keeps a five-character edge label readable by reserving its real wrap width', () => {
    const spec = {
      nodes: [
        { id: 'a', label: '牛顿法', x: 0, y: 0.5 },
        { id: 'b', label: '双循环限存', x: 1, y: 0.5 },
      ],
      edges: [{ from: 'a', to: 'b', label: '双循环限存' }],
    };
    const result = layoutScientificGraph(spec, 864, 320);
    const gap = result.positions.get('b')!.x - result.positions.get('a')!.x - result.nodeWidth;
    const lines = graphLabelLines(spec.edges[0].label!, gap - 20);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join('')).toBe(spec.edges[0].label);
    expect(minimumGraphLabelWidth(spec.edges[0].label!)).toBeLessThanOrEqual(gap - 20);
    expect(graphLabelLines(spec.nodes[1].label, result.nodeWidth - 20).length).toBeLessThanOrEqual(
      2,
    );
    expect(() => graphLabelLines('双循环限存', 40)).toThrow(/enlarge the diagram/);
  });

  it('asks for a wider canvas when two-line labels cannot fit, without shortening them', () => {
    const spec = {
      nodes: [
        { id: 'a', label: '几何基石', x: 0, y: 0.5 },
        { id: 'b', label: '一阶加速', x: 0.3, y: 0.2 },
        { id: 'c', label: '二阶拟牛顿', x: 0.6, y: 0.5 },
        { id: 'd', label: '约束优化', x: 1, y: 0.8 },
      ],
      edges: [
        { from: 'a', to: 'b', label: '双循环限存' },
        { from: 'b', to: 'c', label: '秩二更新内存' },
        { from: 'c', to: 'd', label: '对偶与乘子' },
      ],
    };
    expect(() => layoutScientificGraph(spec, 280, 180)).toThrow(/Graph (needs|layer|branches)/);
    try {
      layoutScientificGraph(spec, 280, 180);
    } catch (error) {
      expect(String(error)).not.toMatch(/shorten/);
    }
  });

  it('rejects an undersized diagram instead of silently overlapping branches', () => {
    expect(() =>
      layoutScientificGraph(
        {
          nodes: Array.from({ length: 6 }, (_, i) => ({
            id: String(i),
            label: '节点',
            x: i ? 1 : 0,
            y: i / 6,
          })),
          edges: Array.from({ length: 5 }, (_, i) => ({ from: '0', to: String(i + 1) })),
        },
        280,
        180,
      ),
    ).toThrow(/height|width|overlap/);
  });
});
