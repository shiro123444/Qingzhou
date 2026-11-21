import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { diagramSourceSpan } from '../../../../packages/utils/src/presentationAnnotation';
import { editCanvasPage } from './canvas-command';
import { prepareNativeDataExport, verifyPptxNativeData } from './native-data-export';
import { renderScientificDiagram, type SemanticBlock } from './semantic-blocks';
import { applyTableDataPatch } from './table-data-edit';

const block: Extract<SemanticBlock, { kind: 'scientific-diagram' }> = {
  id: 'readings',
  kind: 'scientific-diagram',
  title: 'Approved readings',
  provenance: { kind: 'source', reference: 'Approved outline' },
  rect: { x: 60, y: 120, width: 330, height: 152 },
  spec: {
    type: 'table',
    columns: ['条件', '透过率'],
    rows: [['A & B', '0.50']],
    headerFill: '#123456',
    fontSize: 20,
  },
};
const wrap = (contents: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">${contents}</svg>`;
const page: PresentationPlan['slides'][number] = {
  slideId: 'slide-1',
  order: 1,
  svg: wrap(renderScientificDiagram(block)),
  metadata: { contentBlocks: [block] },
};

describe('PPT Master native-table export', () => {
  it('projects only the approved grid, keeping its rendered content and true bounds', () => {
    const [out] = prepareNativeDataExport([page]);
    const doc = parseString(out.svg);
    const node = doc.getElementById('qingzhou-table-readings')!;
    expect(node.getAttribute('data-pptx-native-authority')).toBe('json');
    expect(node.getAttribute('data-pptx-replace-with')).toBe('table');
    expect(node.getElementsByTagName('metadata')).toHaveLength(1);
    const payload = JSON.parse(node.getElementsByTagName('metadata')[0].textContent!);
    expect(payload).toMatchObject({
      schema: 'ppt-master.semantic-table.v2',
      x: 60,
      y: 120,
      width: 330,
      height: 100,
      strict_grid: true,
      columns: [
        { text: '条件', align: 'l' },
        { text: '透过率', align: 'l' },
      ],
      rows: [[{ text: 'A & B' }, { text: '0.50' }]],
      style: { header_fill: '#123456', font_size: 20 },
    });
    expect(payload.column_widths.reduce((a: number, b: number) => a + b)).toBeCloseTo(330);
    expect(payload.row_heights.reduce((a: number, b: number) => a + b)).toBeCloseTo(100);
    expect(node.getElementsByTagName('text')).toHaveLength(4);
    expect(page.svg).not.toContain('data-pptx-replace-with');
  });

  it('keeps both table copies as separate editable Office tables and restores the original on undo', async () => {
    const copy = await editCanvasPage(
      page,
      1,
      {
        kind: 'paste',
        object: block.id,
        sourcePage: 1,
        sourceVersion: 'v1',
        expectedVersionId: 'v1',
      },
      'duplicate',
      async () => page,
    );
    const tables = prepareNativeDataExport([copy])[0].tables;
    expect(tables).toHaveLength(2);
    expect(tables[0].blockId).not.toBe(tables[1].blockId);
    expect(tables[1].rows).toEqual(tables[0].rows);
    const restored = await editCanvasPage(
      copy,
      1,
      {
        kind: 'restore',
        version: 'v1',
        operationId: 'duplicate',
        direction: 'undo',
        expectedVersionId: 'v2',
      },
      'undo',
      async () => page,
    );
    expect(prepareNativeDataExport([restored])).toEqual(prepareNativeDataExport([page]));
  });

  it('preserves the existing export for a stale grid or a foreign replacement marker', () => {
    const edited = { ...page, svg: page.svg.replace('0.50', '0.55') };
    expect(prepareNativeDataExport([edited])).toEqual([
      { svg: edited.svg, tables: [], charts: [] },
    ]);
    const chart = {
      order: 2,
      slideId: 'slide-2',
      svg: wrap('<g data-pptx-replace-with="ch&#97;rt"/>'),
    };
    expect(prepareNativeDataExport([page, chart])).toEqual([
      { svg: page.svg, tables: [], charts: [] },
      { svg: chart.svg, tables: [], charts: [] },
    ]);
  });

  it('updates a native header and cell on their original grid, preserving sibling objects through repeated edits', () => {
    const source = {
      ...page,
      notes: 'Keep notes',
      svg: wrap(
        '<text>Outside title</text><!-- keep -->' +
          renderScientificDiagram(block) +
          '<path d="M0 0L4 4"/>',
      ),
    };
    const sibling = { ...page, slideId: 'slide-2', order: 2 };
    const plan: PresentationPlan = {
      aspectRatio: '16:9',
      title: 'Lab',
      planId: 'p',
      sourceVersionIds: [],
      slides: [source, sibling],
    };
    const input = { notebookId: 'n', sourceVersionIds: [], title: 'Lab' };
    const patch = {
      blockId: 'readings',
      expectedVersionId: 'v1',
      columns: ['分组', '透过率'],
      rows: [['A & B', '0.75']],
    };
    const edit = (p: PresentationPlan, values = patch) =>
      applyTableDataPatch(p, input, {
        tableDataPatch: values,
        target: { type: 'slide', slideNumber: 1 },
      });
    const payload = (p: PresentationPlan) => {
      const [out] = prepareNativeDataExport(p.slides);
      const node = parseString(out.svg).getElementById('qingzhou-table-readings')!;
      return JSON.parse(node.getElementsByTagName('metadata')[0].textContent!);
    };
    const original = payload(plan);
    const once = edit(plan);
    const twice = edit(once.plan, { ...patch, rows: [['A & B', '0.25']] });
    expect(once.input).toBe(input);
    expect(once.slideId).toBe('slide-1');
    for (const [p, value] of [
      [once.plan, '0.75'],
      [twice.plan, '0.25'],
    ] as const) {
      const [edited, other] = p.slides;
      expect(other).toBe(sibling);
      expect(edited.notes).toBe(source.notes);
      const span = diagramSourceSpan(edited.svg, 'readings')!;
      const before = diagramSourceSpan(source.svg, 'readings')!;
      expect(edited.svg.slice(0, span.start)).toBe(source.svg.slice(0, before.start));
      expect(edited.svg.slice(span.end)).toBe(source.svg.slice(before.end));
      expect(edited.svg).toContain('分组');
      expect(edited.svg).toContain(value);
      expect(payload(p)).toMatchObject({
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        style: original.style,
        row_heights: original.row_heights,
        column_widths: original.column_widths,
        columns: [{ text: '分组' }, { text: '透过率' }],
        rows: [[{ text: 'A & B' }, { text: value }]],
      });
    }
    expect(plan.slides[0].svg).toContain('0.50');
    for (const invalid of [
      { ...patch, columns: ['条件', '透过率', '备注'] },
      { ...patch, rows: [...patch.rows, ...patch.rows] },
      { ...patch, rows: [['A & B', '0.75', '额外列']] },
      { ...patch, rows: [['A & B', '数值超长'.repeat(20)]] },
      { ...patch, blockId: 'wrong-table' },
    ])
      expect(() => edit(plan, invalid)).toThrow();
    const stale = { ...source, svg: source.svg.replace('0.50', '0.51') };
    expect(() => edit({ ...plan, slides: [stale] })).toThrow('无法对应');
  });

  it('reads back the named table and rejects missing or altered cell data', () => {
    const prepared = prepareNativeDataExport([page]);
    const deck = (value: string) =>
      zipSync({
        'ppt/slides/slide1.xml': strToU8(
          `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr name="qingzhou-table-readings"/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>
              <a:tr><a:tc><a:t>条件</a:t></a:tc><a:tc><a:t>透过率</a:t></a:tc></a:tr>
              <a:tr><a:tc><a:t>A &amp; B</a:t></a:tc><a:tc><a:t>${value}</a:t></a:tc></a:tr>
            </a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:sld>`,
        ),
      });
    expect(() => verifyPptxNativeData(deck('0.50'), prepared)).not.toThrow();
    expect(() => verifyPptxNativeData(deck('0.55'), prepared)).toThrow('differs');
    expect(() => verifyPptxNativeData(zipSync({}), prepared)).toThrow('omitted');
  });
});
