import path from 'node:path';

import { strFromU8, unzipSync } from 'fflate';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { plotFrame, plotPalette, type ScatterBlock } from './scatter-chart';
import { diagramLabelLines } from './semantic-blocks';

const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export type ChartSeries = { name: string; x: number[]; y: number[] };

/** Same measured plot rectangle, samples and labels as the audited SVG. */
export function scatterChartPayload(block: ScatterBlock, name: string) {
  const { spec, rect } = block;
  const { x, y, width, height } = rect;
  const caption =
    block.provenance.kind === 'source' ? block.provenance.caption : '概念轨迹（非运行结果）';
  const lines = caption ? diagramLabelLines(caption, Math.min(width - 32, width * 0.8)) : [];
  const frame = plotFrame(spec.series, width, height, lines.length);
  const hasMarkers = (length: number) => length >= 3 && length <= 32;
  const marks = hasMarkers(spec.series[0].points!.length);
  if (
    !frame.withLegend ||
    frame.legendLines.some((line) => line.length !== 1) ||
    spec.series.some(({ points }) => hasMarkers(points!.length) !== marks)
  )
    return undefined;
  const face = (spec.fontFamily ?? 'Arial')
    .split(',')[0]
    .trim()
    .replaceAll(/^["']|["']$/gu, '');
  const textColor = (spec.textColor ?? '#334155').toUpperCase();
  return {
    name,
    x,
    y,
    width,
    height,
    type: 'scatter',
    scatter_style: marks ? 'lineMarker' : 'line',
    series: spec.series.map((series): ChartSeries => ({
      name: series.label,
      x: series.points!.map(([value]) => value),
      y: series.points!.map(([, value]) => value),
    })),
    axes: {
      x: {
        minimum: spec.xRange[0],
        maximum: spec.xRange[1],
        major_unit: (spec.xRange[1] - spec.xRange[0]) / 4,
        major_gridlines: false,
      },
      y: {
        minimum: spec.yRange[0],
        maximum: spec.yRange[1],
        major_unit:
          (spec.yRange[1] - spec.yRange[0]) /
          Math.max(1, Math.min(4, Math.floor((frame.bottom - frame.top) / 22))),
        major_gridlines: false,
      },
    },
    axis_titles: { x: spec.xLabel, y: spec.yLabel },
    show_legend: true,
    legend_position: 'top',
    plot_area: {
      x: x + frame.left,
      y: y + frame.top,
      width: frame.right - frame.left,
      height: frame.bottom - frame.top,
    },
    style: {
      colors: spec.series.map((series, index) =>
        (series.color ?? plotPalette[index]).toUpperCase(),
      ),
      text_color: textColor,
      axis_color: '#64748B',
      chart_area_fill: 'none',
      plot_area_fill: 'none',
      font_family: face || 'Arial',
      axis_font_size: 16,
      axis_title_font_size: 16,
      legend_font_size: 16,
    },
    ...(lines.length
      ? {
          notes: lines.map((text, index) => ({
            text,
            x: x + 8,
            y: y + height - 20 * (lines.length - index),
            width: width - 16,
            height: 20,
            color: textColor,
            font_size: 16,
            align: 'l',
          })),
        }
      : {}),
  };
}

function xmlPart(files: Record<string, Uint8Array>, part: string) {
  if (!files[part]) throw new Error(`Missing native chart package part ${part}`);
  return parseString(strFromU8(files[part]));
}

function relatedPart(
  files: Record<string, Uint8Array>,
  part: string,
  relationshipType: string,
  id?: string | null,
) {
  const directory = path.posix.dirname(part);
  const rels = files[`${directory}/_rels/${path.posix.basename(part)}.rels`];
  if (!rels) throw new Error('Missing chart relationship');
  const relationship = Array.from(
    parseString(strFromU8(rels)).getElementsByTagName('Relationship'),
  ).find(
    (entry) =>
      entry.getAttribute('Type') === `${RELATIONSHIPS}/${relationshipType}` &&
      (id === undefined || entry.getAttribute('Id') === id),
  );
  const target = relationship?.getAttribute('Target');
  if (!target || relationship?.getAttribute('TargetMode') === 'External')
    throw new Error('Native chart has no internal data part');
  return target.startsWith('/') ? target.slice(1) : path.posix.join(directory, target);
}

function chartWorkbookCells(workbook: Record<string, Uint8Array>) {
  const part = 'xl/workbook.xml';
  const sheet = Array.from(
    xmlPart(workbook, part).getElementsByTagNameNS(SPREADSHEET, 'sheet'),
  ).find((entry) => entry.getAttribute('name') === 'Sheet1');
  if (!sheet) throw new Error('Native chart workbook has no data worksheet');
  const sheetPart = relatedPart(
    workbook,
    part,
    'worksheet',
    sheet.getAttributeNS(RELATIONSHIPS, 'id'),
  );
  const cells = Array.from(xmlPart(workbook, sheetPart).getElementsByTagNameNS(SPREADSHEET, 'c'));
  const text = (node: Element) =>
    Array.from(node.getElementsByTagNameNS(SPREADSHEET, 't'))
      .map((run) => run.textContent)
      .join('');
  // The upstream tool prefers XlsxWriter, then openpyxl, then its own minimal
  // writer. These serialize the same labels as shared strings or inline text.
  const strings = cells.some((cell) => cell.getAttribute('t') === 's')
    ? Array.from(
        xmlPart(workbook, relatedPart(workbook, part, 'sharedStrings')).getElementsByTagNameNS(
          SPREADSHEET,
          'si',
        ),
      ).map(text)
    : [];
  return new Map(
    cells.map((cell) => {
      const type = cell.getAttribute('t');
      const value = cell.getElementsByTagNameNS(SPREADSHEET, 'v')[0]?.textContent;
      const result =
        type === 's' ? strings[Number(value)] : type === 'inlineStr' ? text(cell) : value;
      return [cell.getAttribute('r'), { type, value: result }];
    }),
  );
}

/** Read through chart relationships, then check both the plotted cache and Edit Data workbook. */
export function verifyNativeChart(
  files: Record<string, Uint8Array>,
  slidePart: string,
  frame: Element,
  expected: ChartSeries[],
) {
  const chartRef = frame.getElementsByTagNameNS(CHART, 'chart')[0];
  const chartPart = relatedPart(
    files,
    slidePart,
    'chart',
    chartRef?.getAttributeNS(RELATIONSHIPS, 'id') ?? null,
  );
  const chart = xmlPart(files, chartPart);
  const scatter = chart.getElementsByTagNameNS(CHART, 'scatterChart')[0];
  if (!scatter) throw new Error('Native chart is missing its XY plot');
  const workbookRef = chart.getElementsByTagNameNS(CHART, 'externalData')[0];
  const workbookPart = relatedPart(
    files,
    chartPart,
    'package',
    workbookRef?.getAttributeNS(RELATIONSHIPS, 'id') ?? null,
  );
  const workbook = unzipSync(files[workbookPart]);
  const cells = chartWorkbookCells(workbook);
  const series = Array.from(scatter.getElementsByTagNameNS(CHART, 'ser'));
  if (series.length !== expected.length) throw new Error('Native chart lost series');
  for (const [index, expectedSeries] of expected.entries()) {
    const source = series[index];
    const tx = source.getElementsByTagNameNS(CHART, 'tx')[0];
    const label = tx?.getElementsByTagNameNS(CHART, 'v')[0]?.textContent;
    const nameReference = tx?.getElementsByTagNameNS(CHART, 'f')[0]?.textContent;
    const nameCell = /^Sheet1!\$([A-Z]+)\$1$/u.exec(nameReference ?? '')?.[1];
    if (label !== expectedSeries.name || !nameCell || cells.get(nameCell + '1')?.value !== label)
      throw new Error('Native chart series name differs from the approved source');
    for (const [axis, values] of [
      ['xVal', expectedSeries.x],
      ['yVal', expectedSeries.y],
    ] as const) {
      const axisNode = source.getElementsByTagNameNS(CHART, axis)[0];
      if (!axisNode) throw new Error('Native chart lost an axis data series');
      const points = Array.from(axisNode.getElementsByTagNameNS(CHART, 'pt'));
      const ref = axisNode.getElementsByTagNameNS(CHART, 'f')[0]?.textContent;
      const column = /^Sheet1!\$([A-Z]+)\$2:\$\1\$(\d+)$/u.exec(ref ?? '');
      if (
        !column ||
        Number(column[2]) !== values.length + 1 ||
        (axis === 'yVal' && column[1] !== nameCell) ||
        points.length !== values.length ||
        values.some((value, i) => {
          const data = points[i].getElementsByTagNameNS(CHART, 'v')[0]?.textContent;
          const cell = cells.get(column[1] + (i + 2));
          return (
            points[i].getAttribute('idx') !== String(i) ||
            !data?.trim() ||
            !cell?.value?.trim() ||
            (cell.type != null && cell.type !== '' && cell.type !== 'n') ||
            Number(data) !== value ||
            // Excel preserves 15 significant digits for numeric worksheet cells.
            Number(cell.value).toPrecision(15) !== value.toPrecision(15)
          );
        })
      )
        throw new Error('Native chart data or embedded workbook differs from the approved samples');
    }
  }
}
