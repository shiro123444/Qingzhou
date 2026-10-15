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
