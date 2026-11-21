import { describe, expect, it } from 'vitest';
import { measureSlideText } from './text-measurement';

import {
  graphLabelLines,
  layoutScientificGraph,
  minimumGraphLabelWidth,
} from './scientific-graph-layout';

describe('scientific graph layout', () => {
  it('keeps a five-step feedback workflow readable and routes the return independently of forward labels', () => {
    const nodes = ['接收材料', '初步复核', '协作处理', '现场验证', '归档记录'].map((label, i) => ({
      id: `n${i}`,
      label,
      x: i / 4,
      y: 0.5,
    }));
    const edges = [
      ...nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id })),
      { from: 'n3', to: 'n0', label: '未通过则重新登记' },
    ];
    const spec = { nodes, edges, style: { nodeFill: 'none', nodeStroke: 'none' } };
    const result = layoutScientificGraph(spec, 576, 128);
    expect(result.feedbackLanes.size).toBe(1);
    expect(result.feedbackLanes.get(4)).toBeGreaterThan(
      Math.max(...[...result.positions.values()].map((p) => p.y + result.nodeHeight / 2)),
    );
    for (const node of nodes)
      expect(result.positions.get(node.id)!.lines.join('')).toBe(node.label);
    expect(() => layoutScientificGraph(spec, 576, 64)).toThrow(/feedback lanes need more height/);
    expect(edges).toHaveLength(5);
  });
  it('separates shortcut edges from every node and each other at the native presentation scale', () => {
    const spec = {
      nodes: [
        { id: 'dispatch', label: '调度员·现场', x: 0.2, y: 0.22 },
        { id: 'field', label: '工程师·现场', x: 0.8, y: 0.22 },
        { id: 'archive', label: '质量岗·次日汇总', x: 0.5, y: 0.8 },
      ],
      edges: [
        { from: 'dispatch', to: 'field', label: '共同验收' },
        { from: 'dispatch', to: 'archive', label: '归档记录' },
        { from: 'field', to: 'archive', label: '归档记录' },
      ],
      style: { nodeFill: 'none', nodeStroke: 'none' },
    };
    expect(() => layoutScientificGraph(spec, 576, 64)).toThrow(/needs more height/);
    const layout = layoutScientificGraph(spec, 576, 160);
    const top = layout.positions.get('dispatch')!.y;
    expect(layout.positions.get('field')!.y).toBe(top);
    expect(layout.positions.get('archive')!.y - top).toBeGreaterThan(60);
    const routes = layout.relationshipRoutes!;
    expect(routes).toHaveLength(3);
    for (const [index, route] of routes.entries()) {
      const box = route!.label!;
      expect(box.lines.join('')).toBe(spec.edges[index].label);
      const target = layout.positions.get(spec.edges[index].to)!;
      for (const [lineIndex, text] of target.lines.entries()) {
        const baseline = target.y + 5 + (lineIndex - (target.lines.length - 1) / 2) * 20;
        const dx = Math.max(0, Math.abs(route.end.x - target.x) - measureSlideText(text, 16) / 2);
        const dy = Math.max(0, baseline - 16 - route.end.y, route.end.y - baseline - 4);
        expect(Math.hypot(dx, dy) * 1.5).toBeGreaterThanOrEqual(12);
      }
      for (const node of layout.positions.values()) {
        const separateX = Math.abs(box.x - node.x) - box.halfWidth - layout.nodeWidth / 2;
        const separateY = Math.abs(box.y - node.y) - box.halfHeight - layout.nodeHeight / 2;
        expect(Math.max(separateX, separateY) * 1.5).toBeGreaterThanOrEqual(16);
      }
    }
    const twoWay = {
      ...spec,
      edges: [...spec.edges, { from: 'field', to: 'dispatch', label: '验收反馈' }],
    };
    const reciprocal = layoutScientificGraph(twoWay, 576, 160).relationshipRoutes!;
    expect(reciprocal).toHaveLength(4);
    expect(reciprocal[3].end.y).not.toBe(reciprocal[0].start.y);
    const collinear = { ...spec, nodes: spec.nodes.map((n, i) => ({ ...n, x: i / 2, y: 0.5 })) };
    expect(layoutScientificGraph(collinear, 576, 160).relationshipRoutes).toHaveLength(3);
  });
  it('fits five text-only steps with relationship captions without reserving invisible card widths', () => {
    const spec = {
      nodes: ['登记异常', '隔离复核', '制定措施', '现场验证', '归档复盘'].map((label, i) => ({
        id: `n${i}`,
        label,
        x: i / 4,
        y: 0.5,
      })),
      edges: Array.from({ length: 4 }, (_, i) => ({
        from: `n${i}`,
        to: `n${i + 1}`,
        label: '责任确认',
      })),
      style: { nodeFill: 'none', nodeStroke: 'none' },
    };
    const result = layoutScientificGraph(spec, 576, 64);
    expect(result.horizontal).toBe(true);
    for (const n of spec.nodes) expect(result.positions.get(n.id)!.lines.join('')).toBe(n.label);
    for (const edge of spec.edges) {
      const gap =
        result.positions.get(edge.to)!.x - result.positions.get(edge.from)!.x - result.nodeWidth;
      expect(graphLabelLines(edge.label, gap - 20).join('')).toBe(edge.label);
    }
    expect(() => layoutScientificGraph({ ...spec, style: undefined }, 576, 64)).toThrow(
      /Graph needs/,
    );
  });
  it('balances a trailing single Chinese character without dropping label text', () => {
    expect(graphLabelLines('社区联络员·翌日衔接', 144)).toEqual(['社区联络员·', '翌日衔接']);
    expect(graphLabelLines('共享研究工具与案例', 136)).toEqual(['共享研究工具与', '案例']);
  });
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
