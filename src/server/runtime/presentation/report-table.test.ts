import { expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { layoutReportTable, renderReportTable, reportTableSchema } from './report-table';
import {
  renderScientificDiagram,
  renderSemanticBlocks,
  semanticBlockSchema,
} from './semantic-blocks';

const table = reportTableSchema.parse({
  type: 'table',
  columns: ['合作单位', '进展', '共建事项'],
  rows: [
    ['德创智控', '已签约', '智能装备与控制方向'],
    ['乐聚智能', '推进中', '具身智能人才培养'],
  ],
  columnWeights: [2, 1, 3],
});

it('keeps a direct edit on its published grid and remeasures an explicitly different slot', () => {
  const initial = layoutReportTable(table, 820);
  const edited = {
    ...table,
    fixedGrid: {
      widths: initial.widths,
      heights: initial.heights,
      verticalPadding: initial.verticalPadding,
    },
  };
  expect(layoutReportTable(edited, 820)).toEqual(initial);
  expect(layoutReportTable(edited, 640)).toEqual(layoutReportTable(table, 640));
});

it('prefers whole Chinese words over equally balanced character fragments without losing content', () => {
  const spec = reportTableSchema.parse({
    type: 'table',
    columns: ['资料', '资料'],
    rows: [['异常照片与描述', '异常照片与描述']],
    fontSize: 20,
  });
  expect(layoutReportTable(spec, 208).rows[1][0]).toEqual(['异常照片', '与描述']);
  const narrow = layoutReportTable(spec, 128);
  expect(narrow.rows[1][0].join('')).toBe('异常照片与描述');
  expect(spec.fontSize).toBe(20);
});

it('keeps native graph and table content while applying an explicitly chosen visual language', () => {
  const block = semanticBlockSchema.parse({
    id: 'styled-flow',
    kind: 'scientific-diagram',
    title: '工作流程',
    provenance: { kind: 'illustrative' },
    rect: { x: 48, y: 136, width: 864, height: 300 },
    spec: {
      type: 'graph',
      style: {
        nodeFill: 'none',
        nodeStroke: '#0F766E',
        edgeColor: '#0F766E',
        textColor: '#163D37',
        fontFamily: 'Hiragino Sans GB, Arial',
        borderRadius: 0,
      },
      nodes: [
        { id: 'a', label: '需求输入', x: 0.2, y: 0.5 },
        { id: 'b', label: '导出下载', x: 0.8, y: 0.5 },
      ],
      edges: [{ from: 'a', to: 'b' }],
    },
  });
  if (block.kind !== 'scientific-diagram') throw new Error('Expected diagram');
  const graph = renderScientificDiagram(block);
  expect(graph).toContain('需求输入');
  expect(graph).toContain('rx="0"');
  expect(graph).toContain('stroke="#0F766E"');
  expect(graph).not.toContain('#2563eb');
  expect(graph).toContain('font-family="Hiragino Sans GB, Arial"');
  const styled = reportTableSchema.parse({
    ...table,
    fontFamily: 'Hiragino Sans GB, Arial',
    headerText: '#163D37',
    headerFill: '#FFFFFF',
    bodyFill: '#FFFFFF',
    bandFill: '#FFFFFF',
  });
  const svg = renderReportTable(styled, 864, 400);
  expect(svg).toContain('德创智控');
  expect(svg).toContain('font-family="Hiragino Sans GB, Arial"');
  expect(svg).not.toContain('#1D3E6B');
});

it('keeps document provenance in metadata instead of painting internal attachment IDs on diagrams', () => {
  const block = semanticBlockSchema.parse({
    id: 'flow',
    kind: 'scientific-diagram',
    title: '工作流程',
    provenance: { kind: 'source', reference: '汇报材料.docx [attachment-private:segment-1]' },
    rect: { x: 48, y: 136, width: 864, height: 364 },
    spec: {
      type: 'graph',
      nodes: [
        { id: 'a', label: '工作计划', x: 0.2, y: 0.5 },
        { id: 'b', label: '实施反馈', x: 0.8, y: 0.5 },
      ],
      edges: [{ from: 'a', to: 'b' }],
    },
  });
  if (block.kind !== 'scientific-diagram') throw new Error('expected diagram');
  const svg = renderScientificDiagram(block);
  expect(svg).not.toContain('attachment-private');
  expect(svg).not.toContain('来源');
  expect(block.provenance.reference).toContain('attachment-private');
});

it('measures every cell and preserves rows as editable text with no generic source footer', () => {
  const layout = layoutReportTable(table, 864);
  const svg = renderReportTable(table, 864, layout.height);
  expect(svg).toContain('乐聚智能');
  expect(svg).toContain('推进中');
  expect(svg).not.toContain('<image');
  expect(svg).not.toContain('资料来源');
  const compact = layoutReportTable(table, 864, 0);
  expect(compact.height).toBeLessThan(layout.height);
  expect(renderReportTable(table, 864, compact.height)).toContain('font-size="20"');
  expect(() => renderReportTable(table, 864, compact.height - 1)).toThrow('requires');
  expect(() => layoutReportTable({ ...table, rows: [['缺少列']] }, 864)).toThrow('match');
});

it('funds actual cell demand before weight priors and avoids orphans for varying evidence lengths', () => {
  for (const length of [12, 18, 24, 32, 44, 60]) {
    const sample = reportTableSchema.parse({
      type: 'table',
      columns: ['序号', '事项', '证据'],
      rows: [
        ['1', '保留全部内容', '资料'.repeat(length)],
        ['2', '另一项', '状态已核实'],
      ],
      columnWeights: [3, 3, 4],
      fontSize: 20,
    });
    const result = layoutReportTable(sample, 864);
    for (let row = 0; row < result.rows.length; row++)
      for (let col = 0; col < 3; col++) {
        expect(result.rows[row][col].join('')).toBe([sample.columns, ...sample.rows][row][col]);
        if (result.rows[row][col].length > 1)
          expect([...result.rows[row][col].at(-1)!].length).toBeGreaterThan(2);
      }
    expect(result.widths[0]).toBeLessThan(result.widths[2]);
  }
});

it('balances CJK punctuation while retaining explicit paragraphs and unbroken identifiers', () => {
  const sample = reportTableSchema.parse({
    type: 'table',
    columns: ['项目', '说明'],
    rows: [['SVG_EXPORT', '核对（完整数据），保留全部文字。\n下一段不可合并。']],
  });
  const result = layoutReportTable(sample, 420);
  expect(result.rows[1][0].join('')).toBe('SVG_EXPORT');
  expect(result.rows[1][1]).toContain('下一段不可合并。');
  expect(result.rows[1][1].some((line) => /^[，。）》]/u.test(line))).toBe(false);
});

it('balances compact labels across lines instead of leaving a short tail', () => {
  const sample = reportTableSchema.parse({
    type: 'table',
    columns: ['序号', '检查事项'],
    rows: [['1', '交付文档应当包含完整操作记录']],
    fontSize: 24,
  });
  const lines = layoutReportTable(sample, 330).rows[1][1];
  expect(lines.join('')).toBe(sample.rows[0][1]);
  expect(lines).toHaveLength(2);
  expect(Math.abs([...lines[0]].length - [...lines[1]].length)).toBeLessThanOrEqual(1);
});

it('runs a native table through the semantic renderer without losing its editable source', async () => {
  const block = {
    id: 'cooperation',
    kind: 'scientific-diagram',
    title: '合作矩阵',
    provenance: { kind: 'source', reference: '用户原始汇报材料' },
    rect: { x: 48, y: 136, width: 864, height: 360 },
    spec: table,
  };
  const result = await renderSemanticBlocks(
    '<svg viewBox="0 0 960 540"><g data-deck-body="true"><g data-content-id="cooperation"/></g></svg>',
    [block],
  );
  expect(result.svg).toContain('data-report-table="true"');
  expect(result.blocks[0]).toEqual(block);
  const doc = parseString(result.svg);
  expect(doc.getElementsByTagName('g')[0].getAttribute('data-deck-body')).toBe('true');
  expect(doc.getElementsByTagName('g')[1].getAttribute('data-scientific-diagram')).toBe(
    'cooperation',
  );
});

it('keeps a complete header label above its variable instead of balancing a word fragment against a short symbol', () => {
  const spec = reportTableSchema.parse({
    type: 'table',
    columns: ['条件', '峰值 Imax', '底值 Imin', '峰底比 R'],
    rows: [
      ['条件A', '8', '1', '8'],
      ['条件B', '12', '1', '12'],
      ['条件D', '16', '2', '8'],
    ],
    fontSize: 20,
    fontFamily: 'Hiragino Sans GB, Arial',
    columnWeights: [1.6, 1.5, 1.5, 1.5],
  });
  const result = layoutReportTable(spec, 378);
  expect(result.rows[0][3].some((line) => line.includes('峰底比'))).toBe(true);
  expect(result.rows[0][3].join('').replaceAll(/\s/gu, '')).toBe('峰底比R');
  expect(result.rows.slice(1).map((row) => row.map((lines) => lines.join('')))).toEqual(spec.rows);
  expect(spec.fontSize).toBe(20);
});
