import { translateInPage } from '../../../utils/presentationCanvasTransform';
import { canvasNode } from '../../../../packages/utils/src/presentationAnnotation';
import type { CanvasObject } from '@/features/SpatialCanvas';

import type { EditableChart } from './ChartDataEditor';
import type { EditableTable } from './TableDataEditor';

export interface SlideCanvasObject extends CanvasObject {
  label: string;
}

export function presentationCanvasObjects(raw: unknown, nativeData?: unknown) {
  const chartIds =
    nativeData &&
    typeof nativeData === 'object' &&
    'charts' in nativeData &&
    Array.isArray(nativeData.charts) &&
    nativeData.charts.every((id) => typeof id === 'string')
      ? new Set<string>(nativeData.charts)
      : undefined;
  const nativeTables =
    nativeData &&
    typeof nativeData === 'object' &&
    'tables' in nativeData &&
    Array.isArray(nativeData.tables)
      ? new Set(nativeData.tables)
      : new Set();
  const tables: EditableTable[] = [];
  const objects: SlideCanvasObject[] = [];
  const charts: EditableChart[] = [];
  for (const block of Array.isArray(raw) ? raw : []) {
    if (
      !block ||
      !['formula', 'scientific-diagram'].includes(block.kind) ||
      typeof block.id !== 'string' ||
      !block.rect
    )
      continue;
    const { height, width, x, y } = block.rect;
    if (![height, width, x, y].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const label = block.title || block.latex || block.id;
    objects.push({ id: block.id, height, width, x, y, label: String(label) });
    const spec = block.spec;
    if (
      spec?.type === 'table' &&
      nativeTables.has(block.id) &&
      Array.isArray(spec.columns) &&
      spec.columns.length >= 2 &&
      spec.columns.every((v: unknown) => typeof v === 'string') &&
      Array.isArray(spec.rows) &&
      spec.rows.length > 0 &&
      spec.rows.every(
        (row: unknown) =>
          Array.isArray(row) &&
          row.length === spec.columns.length &&
          row.every((v) => typeof v === 'string'),
      )
    ) {
      tables.push({ id: block.id, title: block.title, columns: spec.columns, rows: spec.rows });
      continue;
    }
    if (
      spec?.type !== 'plot' ||
      spec.equalAspect ||
      typeof spec.xLabel !== 'string' ||
      typeof spec.yLabel !== 'string' ||
      !Array.isArray(spec.series) ||
      !spec.series.length ||
      !spec.series.every(
        (item: EditableChart['series'][number] & { arrowEnd?: boolean }) =>
          item &&
          typeof item.label === 'string' &&
          !item.arrowEnd &&
          Array.isArray(item.points) &&
          item.points.length >= 2 &&
          item.points.every(
            (point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
          ),
      )
    )
      continue;
    charts.push({
      exportFormat: chartIds ? (chartIds.has(block.id) ? 'chart' : 'shapes') : undefined,
      id: block.id,
      title: label,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
      series: spec.series,
    });
  }
  return { objects, charts, tables };
}

/** The hit plane, display and saved coordinates use the original page's SVG user space. */
export function readCanvasDocument(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg') return;
  const bounds = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    !bounds ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[2] <= 0 ||
    bounds[3] <= 0
  )
    return;
  const [x, y, width, height] = bounds;
  return { document, x, y, width, height };
}

function findObjectGroup(copy: Element, id: string) {
  return canvasNode(copy, id);
}

export function movePreview(document: Document, object: CanvasObject, x: number, y: number) {
  const copy = document.documentElement.cloneNode(true) as Element;
  const group = findObjectGroup(copy, object.id);
  if (!group) return;
  translateInPage(group, x - object.x, y - object.y);
  return new XMLSerializer().serializeToString(copy);
}

/** Split the selected SVG group only for the duration of a drag. Both images keep the
 * original viewBox, font cascade and definitions so moving uses a single CSS transform. */
export function dragPreviewParts(document: Document, selection: string | string[]) {
  const ids = typeof selection === 'string' ? [selection] : selection;
  const background = document.documentElement.cloneNode(true) as Element;
  const object = document.documentElement.cloneNode(true) as Element;
  const removing = ids.map((id) => findObjectGroup(background, id));
  const keeping = ids.map((id) => findObjectGroup(object, id));
  if (!ids.length || removing.some((n) => !n) || keeping.some((n) => !n)) return;
  removing.forEach((n) => n!.remove());
  function prune(parent: Element) {
    for (const child of Array.from(parent.children)) {
      if (['defs', 'style'].includes(child.localName) || keeping.includes(child)) continue;
      if (keeping.some((n) => child.contains(n!))) prune(child);
      else child.remove();
    }
  }
  prune(object);
  const serialize = new XMLSerializer();
  return {
    background: serialize.serializeToString(background),
    object: serialize.serializeToString(object),
  };
}
