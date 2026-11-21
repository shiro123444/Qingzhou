import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { applyChartDataPatch, assertChartDataPatchTarget } from './chart-data-edit';
import { prepareNativeDataExport, verifyPptxNativeData } from './native-data-export';
import type { ScatterBlock } from './scatter-chart';
import { renderScientificDiagram } from './semantic-blocks';

const chart: ScatterBlock = {
  kind: 'scientific-diagram',
  id: 'load',
  title: 'Calibration',
  rect: { x: 120, y: 115, width: 540, height: 300 },
  provenance: { kind: 'source', reference: 'Approved samples' },
  spec: {
    type: 'plot',
    xRange: [0, 4],
    yRange: [0, 20],
    xLabel: 'Force',
    yLabel: 'Signal',
    series: [
      {
        label: 'Load',
        points: [
          [1, 8],
          [2, 12],
          [3, 16],
        ],
      },
    ],
  },
};
const note = 'Forces 1, 2, 3 correspond to signals 8, 12, 16';
const page = {
  order: 1,
  slideId: 'slide-1',
  notes: note,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><text x="42" y="80">${note}</text>${renderScientificDiagram(chart)}</svg>`,
  metadata: { contentBlocks: [chart], outline: [note] },
};
const plotNS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
function rel(pairs: string[][]) {
  return strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pairs.map(([id, type, file]) => `<Relationship Id="${id}" Type="${relNS}/${type}" Target="${file}"/>`).join('')}</Relationships>`,
  );
}
function packageWith(workbookY: number, cacheY = 16, shared = true) {
  const points = (tag: string, col: string, values: number[]) =>
    `<c:${tag}><c:numRef><c:f>Sheet1!$${col}$2:$${col}$4</c:f><c:numCache>${values.map((n, i) => `<c:pt idx="${i}"><c:v>${n}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:${tag}>`;
  const values = [8, 12, workbookY];
  const rows = values
    .map(
      (n, i) => `<row><c r="A${i + 2}"><v>${i + 1}</v></c><c r="B${i + 2}"><v>${n}</v></c></row>`,
    )
    .join('');
  const header = shared
    ? '<c r="B1" t="s"><v>0</v></c>'
    : '<c r="B1" t="inlineStr"><is><t>Load</t></is></c>';
  return zipSync({
    'ppt/slides/slide1.xml': strToU8(
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:c="${plotNS}" xmlns:r="${relNS}"><p:graphicFrame><p:cNvPr name="qingzhou-chart-load"/><c:chart r:id="data"/></p:graphicFrame></p:sld>`,
    ),
    'ppt/slides/_rels/slide1.xml.rels': rel([['data', 'chart', '../charts/chart101.xml']]),
    'ppt/charts/chart101.xml': strToU8(
      `<c:chartSpace xmlns:c="${plotNS}" xmlns:r="${relNS}"><c:scatterChart><c:ser><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Load</c:v></c:pt></c:strCache></c:strRef></c:tx>${points('xVal', 'A', [1, 2, 3])}${points('yVal', 'B', [8, 12, cacheY])}</c:ser></c:scatterChart><c:externalData r:id="source"/></c:chartSpace>`,
    ),
    'ppt/charts/_rels/chart101.xml.rels': rel([
      ['source', 'package', '../embeddings/samples.xlsx'],
    ]),
    'ppt/embeddings/samples.xlsx': zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook xmlns="${sheetNS}" xmlns:r="${relNS}"><sheets><sheet name="Sheet1" r:id="sheet"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': rel([
        ['sheet', 'worksheet', 'worksheets/readings.xml'],
        ['strings', 'sharedStrings', 'sharedStrings.xml'],
      ]),
      'xl/worksheets/readings.xml': strToU8(
        `<worksheet xmlns="${sheetNS}"><sheetData><row>${header}</row>${rows}</sheetData></worksheet>`,
      ),
      ...(shared
        ? {
            'xl/sharedStrings.xml': strToU8(
              `<sst xmlns="${sheetNS}"><si><r><t>Lo</t></r><r><t>ad</t></r></si></sst>`,
            ),
          }
        : {}),
    }),
  });
}

describe('source-backed editable presentations', () => {
  it('verifies the chart cache and the numeric cells of both supported workbook string encodings', () => {
    const pages = prepareNativeDataExport([page]);
    expect(pages[0].charts[0].series).toEqual([{ name: 'Load', x: [1, 2, 3], y: [8, 12, 16] }]);
    expect(() => verifyPptxNativeData(packageWith(16), pages)).not.toThrow();
    expect(() => verifyPptxNativeData(packageWith(16, 16, false), pages)).not.toThrow();
    expect(() => verifyPptxNativeData(packageWith(17), pages)).toThrow('workbook');
    expect(() => verifyPptxNativeData(packageWith(16, 17), pages)).toThrow('data');
  });

  it('updates only the identified chart and its matching written source, and preserves its peer', () => {
    const peer = { slideId: 'slide-2', order: 2, svg: page.svg };
    const plan: PresentationPlan = {
      title: 'Samples',
      planId: 'a',
      aspectRatio: '16:9',
      sourceVersionIds: [],
      slides: [page, peer],
    };
    const points: [number, number][] = [
      [1, 8],
      [2, 12],
      [3, 17],
    ];
    const message = {
      chartDataPatch: { blockId: 'load', expectedVersionId: 'v1', series: [points] },
      target: { type: 'slide' as const, slideNumber: 1 },
    };
    const input = {
      title: 'Samples',
      notebookId: 'n',
      sourceVersionIds: [],
      options: { outline: [{ keyPoints: [note] }] },
    };
    const result = applyChartDataPatch(plan, input, message);
    const revised = note.replace('16', '17');
    expect(result.plan.slides[1]).toBe(peer);
    expect(result.plan.slides[0].notes).toBe(revised);
    expect(result.plan.slides[0].svg).toContain(revised);
    expect(result.input.options?.outline).toEqual([{ keyPoints: [revised] }]);
    expect(prepareNativeDataExport(result.plan.slides)[0].charts[0].series[0].y).toEqual([
      8, 12, 17,
    ]);
    const unrelated = 'Times 1, 2 correspond to readings 2, 3';
    const changed = { ...plan, slides: [{ ...page, notes: unrelated }] };
    expect(applyChartDataPatch(changed, input, message).plan.slides[0].notes).toBe(unrelated);
    expect(() =>
      assertChartDataPatchTarget(plan, { type: 'slide', slideNumber: 2 }, message.chartDataPatch),
    ).toThrow('图表');
  });
});
