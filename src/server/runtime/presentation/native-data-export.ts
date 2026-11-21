import { strFromU8, unzipSync } from 'fflate';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import { designFingerprint } from './design-evidence';
import { type ChartSeries, scatterChartPayload, verifyNativeChart } from './native-chart-export';
import { layoutReportTable, reportTableAppearance } from './report-table';
import { isEditableScatter } from './scatter-chart';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

const SVG = 'http://www.w3.org/2000/svg';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const appearanceAttributes = ['transform', 'clip-path', 'mask', 'filter', 'opacity'];

interface PlannedTable {
  readonly blockId: string;
  readonly name: string;
  readonly payloadDigest: string;
  readonly rows: string[][];
}

interface PlannedChart {
  readonly blockId: string;
  readonly name: string;
  readonly payloadDigest: string;
  readonly series: ChartSeries[];
}

interface ExportPage {
  readonly charts: PlannedChart[];
  readonly svg: string;
  readonly tables: PlannedTable[];
}

export function pasteContentLayer(
  root: Element,
  rect: { x: number; y: number; width: number; height: number },
) {
  const layer = Array.from(root.childNodes)
    .filter((item): item is Element => item.nodeType === 1)
    .findLast((el) => {
      if (
        el.localName !== 'g' ||
        el.hasAttribute('data-scientific-diagram') ||
        el.hasAttribute('data-content-id') ||
        el.hasAttribute('data-pptx-role') ||
        appearanceAttributes.some((attr) => el.hasAttribute(attr))
      )
        return false;
      const bounds = el
        .getAttribute('data-pptx-bounds')
        ?.trim()
        .split(/[\s,]+/u)
        .map(Number);
      if (!bounds || bounds.length !== 4) return false;
      const [x, y, width, height] = bounds;
      return (
        rect.x >= x &&
        rect.y >= y &&
        rect.x + rect.width <= x + width &&
        rect.y + rect.height <= y + height
      );
    });
  if (layer) return layer;
  const viewBox = root.getAttribute('viewBox');
  if (!viewBox) return root;
  // Imported slides may have no content layer. Keep their original paint order
  // in one page-sized module so two intentionally stacked copies remain peers.
  const document = root.ownerDocument!;
  const content = document.createElementNS(SVG, 'g');
  let id = 'canvas-content';
  while (document.getElementById(id)) id += '-layer';
  content.setAttribute('id', id);
  content.setAttribute('data-pptx-bounds', viewBox);
  for (const child of Array.from(root.childNodes)) {
    if (
      child.nodeType === 1 &&
      ['defs', 'style', 'metadata', 'desc', 'title'].includes((child as Element).localName)
    )
      continue;
    content.appendChild(child);
  }
  root.appendChild(content);
  return content;
}

/** Project verified server-rendered objects into the corresponding PPT Master data contracts. */
export function prepareNativeDataExport(slides: PresentationPlan['slides']): ExportPage[] {
  const unchanged = () => slides.map(({ svg }) => ({ svg, tables: [], charts: [] }));
  if (!slides.some((slide) => Array.isArray(slide.metadata?.contentBlocks))) return unchanged();

  const documents = slides.map(({ svg }) => parseString(svg));
  // Upstream enables replacement deck-wide. Preserve shape export when an
  // existing unrelated marker has separate authorship or its own authority.
  if (
    documents.some((doc) =>
      Array.from(doc.getElementsByTagName('*')).some((element) =>
        /^(?:chart|table)$/iu.test(element.getAttribute('data-pptx-replace-with')?.trim() ?? ''),
      ),
    )
  )
    return unchanged();

  return slides.map(({ svg, metadata }, index) => {
    const document = documents[index];
    const tables: PlannedTable[] = [];
    const charts: PlannedChart[] = [];
    for (const raw of Array.isArray(metadata?.contentBlocks) ? metadata.contentBlocks : []) {
      const parsed = semanticBlockSchema.safeParse(raw);
      if (!parsed.success || parsed.data.kind !== 'scientific-diagram') continue;
      const block = parsed.data;
      const chart = isEditableScatter(block);
      if (!chart && block.spec.type !== 'table') continue;
      const matches = Array.from(document.getElementsByTagName('g')).filter(
        (element) => element.getAttribute('data-scientific-diagram') === block.id,
      );
      const name = `qingzhou-${chart ? 'chart' : 'table'}-${block.id}`;
      if (matches.length !== 1 || document.getElementById(name)) continue;
      const group = matches[0];
      let contextual = false;
      for (let node = group.parentNode; node?.nodeType === 1; node = node.parentNode) {
        if (appearanceAttributes.some((attr) => (node as Element).hasAttribute(attr))) {
          contextual = true;
          break;
        }
      }
      if (contextual) continue;

      try {
        const expected = parseString(`<svg xmlns="${SVG}">${renderScientificDiagram(block)}</svg>`);
        const actual = group.cloneNode(true) as Element;
        actual.removeAttribute('data-canvas-group');
        if (actual.toString() !== expected.getElementsByTagName('g')[0].toString()) continue;
      } catch {
        continue;
      }
      // A pasted data object belongs to the slide's content layer. When an older
      // editable revision placed it at the root, Office's native bounds would
      // otherwise declare a second, overlapping *page layout module*.
      if (/^copy-[a-f0-9]{12}$/u.test(block.id) && group.parentNode === document.documentElement) {
        const container = pasteContentLayer(document.documentElement, block.rect);
        if (container !== document.documentElement) container.appendChild(group);
      }
      if (chart) {
        const payload = scatterChartPayload(block, name);
        if (!payload) continue;
        stamp(document, group, 'chart', payload);
        charts.push({
          blockId: block.id,
          name,
          payloadDigest: designFingerprint(payload),
          series: payload.series,
        });
        continue;
      }
      const { x, y, width, height } = block.rect;
      const spec = block.spec;
      if (spec.type !== 'table') continue;
      const scale = block.canvasScale ?? 1;
      const design = layoutReportTable(spec, width / scale, height / scale);
      const layout = {
        ...design,
        height: design.height * scale,
        widths: design.widths.map((v) => v * scale),
        heights: design.heights.map((v) => v * scale),
        verticalPadding: design.verticalPadding * scale,
      };
      const paint = reportTableAppearance(spec);
      const font = paint.fontFamily
        .split(',')[0]
        .trim()
        .replaceAll(/^["']|["']$/gu, '');
      // The upstream converter budgets a 1.4em line box for native cells.
      if (
        !font ||
        layout.rows.some(
          (row, i) =>
            Math.max(...row.map((lines) => lines.length), 1) * spec.fontSize * scale * 1.4 >
            layout.heights[i] + 0.01,
        )
      )
        continue;
      const rule = { style: 'solid', color: paint.rule, width: 1 };
      const noRule = { style: 'none' };
      const cells = layout.rows.map((row, rowIndex) =>
        row.map((lines) => ({
          align: 'l',
          borders: {
            bottom: rule,
            top: rowIndex ? rule : noRule,
            left: noRule,
            right: noRule,
          },
          ...(lines.length > 1 ? { paragraphs: lines } : { text: lines[0] ?? '' }),
        })),
      );
      const payload = {
        schema: 'ppt-master.semantic-table.v2',
        name,
        x,
        y,
        width,
        height: layout.height,
        strict_grid: true,
        columns: cells[0],
        rows: cells.slice(1),
        column_widths: layout.widths,
        row_heights: layout.heights,
        style: {
          band_row: true,
          band_fill: paint.bandFill,
          body_fill: paint.bodyFill,
          body_text: paint.bodyText,
          font_family: font,
          font_size: spec.fontSize * scale,
          header_fill: paint.headerFill,
          header_text: paint.headerText,
          padding: {
            left: 12 * scale,
            right: 12 * scale,
            top: layout.verticalPadding / 2,
            bottom: layout.verticalPadding / 2,
          },
          valign: 'middle',
        },
      };
      stamp(document, group, 'table', payload);
      tables.push({
        blockId: block.id,
        name,
        payloadDigest: designFingerprint(payload),
        rows: layout.rows.map((row) => row.map((lines) => lines.join(''))),
      });
    }
    return { svg: tables.length || charts.length ? document.toString() : svg, tables, charts };
  });
}

function stamp(
  document: XMLDocument,
  group: Element,
  kind: 'chart' | 'table',
  payload: { name: string; x: number; y: number; width: number; height: number },
) {
  group.setAttribute('id', payload.name);
  group.setAttribute(
    'data-pptx-bounds',
    `${payload.x} ${payload.y} ${payload.width} ${payload.height}`,
  );
  group.setAttribute('data-pptx-replace-with', kind);
  group.setAttribute('data-pptx-native-authority', 'json');
  const metadataNode = document.createElementNS(SVG, 'metadata');
  metadataNode.setAttribute('type', 'application/json');
  metadataNode.appendChild(document.createTextNode(JSON.stringify(payload)));
  group.insertBefore(metadataNode, group.firstChild);
}

export function verifyPptxNativeData(bytes: Uint8Array, pages: ExportPage[]): void {
  const files = unzipSync(bytes, {
    filter: ({ name }) =>
      /^ppt\/(?:slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?|charts\/[^/]+\.xml|charts\/_rels\/[^/]+\.rels|embeddings\/[^/]+\.xlsx)$/u.test(
        name,
      ),
  });
  for (const [index, page] of pages.entries()) {
    if (!page.tables.length && !page.charts.length) continue;
    const slidePart = `ppt/slides/slide${index + 1}.xml`;
    const slide = files[slidePart];
    if (!slide) throw new Error('Native data export omitted a slide');
    const document = parseString(strFromU8(slide));
    const frames = Array.from(document.getElementsByTagNameNS(PRESENTATION, 'graphicFrame'));
    const matches = (name: string) =>
      frames.filter(
        (frame) =>
          frame.getElementsByTagNameNS(PRESENTATION, 'cNvPr')[0]?.getAttribute('name') === name,
      );
    for (const chart of page.charts) {
      const matching = matches(chart.name);
      if (matching.length !== 1) throw new Error('Native chart missing from PowerPoint slide');
      verifyNativeChart(files, slidePart, matching[0], chart.series);
    }
    for (const expected of page.tables) {
      const matching = matches(expected.name);
      const tables = matching.flatMap((frame) =>
        Array.from(frame.getElementsByTagNameNS(DRAWING, 'tbl')),
      );
      const actual =
        tables.length === 1 &&
        Array.from(tables[0].getElementsByTagNameNS(DRAWING, 'tr')).map((row) =>
          Array.from(row.getElementsByTagNameNS(DRAWING, 'tc')).map((cell) =>
            Array.from(cell.getElementsByTagNameNS(DRAWING, 't'))
              .map((text) => text.textContent)
              .join(''),
          ),
        );
      if (JSON.stringify(actual) !== JSON.stringify(expected.rows))
        throw new Error(`Native table ${expected.blockId} differs from its approved grid`);
    }
  }
}
