import { editableTextNodes } from '../../../../packages/utils/src/presentationAnnotation';
export interface ElementBox {
  height: number;
  index: number;
  kind?: 'text' | 'image' | 'line' | 'shape' | 'background';
  label?: string;
  runs?: (AnnotationRegion & {
    family: string;
    weight: string;
    size: number;
    color: string;
    italic: string;
    spacing: string;
  })[];

  width: number;
  x: number;
  y: number;
}
export type AnnotationRegion = Pick<ElementBox, 'x' | 'y' | 'width' | 'height'>;
const tags = new Set([
  'svg',
  'g',
  'text',
  'tspan',
  'image',
  'rect',
  'circle',
  'ellipse',
  'path',
  'line',
  'polyline',
  'polygon',
  'use',
]);
const attributes = new Set([
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'd',
  'points',
  'transform',
  'viewBox',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'stroke-width',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'dx',
  'dy',
]);
/** Reconstruct geometry only: no live markup, URLs, event handlers or external assets. */
export function measureAnnotationElements(source: string): ElementBox[] {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('无法读取页面元素');
  const nodes: { node: SVGGraphicsElement; source: Element }[] = [];
  function copy(element: Element, insideAtomic = false): SVGElement | null {
    if (!tags.has(element.localName)) return null;
    const output = document.createElementNS('http://www.w3.org/2000/svg', element.localName);
    for (const attr of element.attributes)
      if (attributes.has(attr.name)) output.setAttribute(attr.name, attr.value);
    // Honor only geometric style properties; never copy arbitrary CSS.
    for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
      const [name, value] = declaration.split(':');
      if (attributes.has(name?.trim()) && value && !/url|[<>]/i.test(value))
        output.setAttribute(name.trim(), value.trim());
    }
    const atomic = !['svg', 'g', 'tspan'].includes(element.localName);
    if (atomic && !insideAtomic)
      nodes.push({ node: output as SVGGraphicsElement, source: element });
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE)
        output.append(document.createTextNode(child.textContent ?? ''));
      else if (child instanceof Element) {
        const cloned = copy(child, insideAtomic || atomic);
        if (cloned) output.append(cloned);
      }
    }
    return output;
  }
  const svg = copy(parsed.documentElement) as SVGSVGElement;
  const box = parsed.documentElement
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number) ?? [0, 0, 960, 540];
  svg.setAttribute('width', String(box[2]));
  svg.setAttribute('height', String(box[3]));
  Object.assign(svg.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.append(svg);
  try {
    return nodes.map(({ node, source }, index) => {
      const bounds = node.getBBox();
      const type = source.localName;
      const kind: ElementBox['kind'] =
        source.getAttribute('data-pptx-role') === 'background'
          ? 'background'
          : type === 'text' || type === 'image' || type === 'line'
            ? type
            : 'shape';
      const label = (type === 'text' ? source.textContent : source.getAttribute('aria-label'))
        ?.replace(/\s+/gu, ' ')
        .trim();
      // getBBox excludes stroke. Give horizontal/vertical lines their painted
      // width so that a line remains selectable on the pointer and keyboard.
      const stroke =
        bounds.width === 0 || bounds.height === 0
          ? parseFloat(getComputedStyle(node).strokeWidth) || 1
          : 0;
      const padX = bounds.width === 0 && bounds.height > 0 ? stroke / 2 : 0;
      const padY = bounds.height === 0 && bounds.width > 0 ? stroke / 2 : 0;

      const matrix = node.getCTM();
      const points = [
        [bounds.x - padX, bounds.y - padY],
        [bounds.x + bounds.width + padX, bounds.y - padY],
        [bounds.x - padX, bounds.y + bounds.height + padY],
        [bounds.x + bounds.width + padX, bounds.y + bounds.height + padY],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix ?? undefined));
      const left = Math.min(...points.map((p) => p.x));
      const top = Math.min(...points.map((p) => p.y));
      const svgBounds = svg.getBoundingClientRect();
      const runs =
        type === 'text' && svgBounds.width
          ? editableTextNodes(node).map((text, i) => {
              const range = document.createRange();
              range.selectNodeContents(text);
              const r = range.getBoundingClientRect(),
                parent = text.parentElement!,
                style = getComputedStyle(parent);
              const authored = editableTextNodes(source)[i]?.parentElement;
              const color = authored?.closest('[fill]')?.getAttribute('fill') ?? 'black';
              return {
                x: (r.left - svgBounds.left) / svgBounds.width,
                y: (r.top - svgBounds.top) / svgBounds.height,
                width: r.width / svgBounds.width,
                height: r.height / svgBounds.height,
                family: style.fontFamily,
                weight: style.fontWeight,
                italic: style.fontStyle,
                spacing: style.letterSpacing,
                size:
                  (parseFloat(style.fontSize) * Math.hypot(matrix?.a ?? 1, matrix?.b ?? 0)) /
                  box[2],
                color: globalThis.CSS?.supports?.('color', color) ? color : 'black',
              };
            })
          : undefined;
      return {
        ...(runs?.length ? { runs } : {}),
        index,
        kind,
        label,
        x: left / box[2],
        y: top / box[3],
        width: (Math.max(...points.map((p) => p.x)) - left) / box[2],
        height: (Math.max(...points.map((p) => p.y)) - top) / box[3],
      };
    });
  } finally {
    svg.remove();
  }
}

export function selectAnnotationElements(
  boxes: ElementBox[],
  region: AnnotationRegion,
  tolerance = { x: 0.004, y: 0.007 },
) {
  const point = region.width === 0 && region.height === 0;
  const hits = boxes.filter(
    (b) =>
      b.kind !== 'background' &&
      b.width > 0 &&
      b.height > 0 &&
      (point
        ? region.x >= b.x - tolerance.x &&
          region.x <= b.x + b.width + tolerance.x &&
          region.y >= b.y - tolerance.y &&
          region.y <= b.y + b.height + tolerance.y
        : b.x >= region.x &&
          b.y >= region.y &&
          b.x + b.width <= region.x + region.width &&
          b.y + b.height <= region.y + region.height),
  );
  const containsPoint = (b: ElementBox) =>
    region.x >= b.x && region.x <= b.x + b.width && region.y >= b.y && region.y <= b.y + b.height;
  // Prefer the element directly under the pointer, then the smallest candidate
  // and the topmost paint order. Touch slop must not steal a nearby text hit.
  return (
    point
      ? hits
          .sort(
            (a, b) =>
              Number(containsPoint(b)) - Number(containsPoint(a)) ||
              a.width * a.height - b.width * b.height ||
              b.index - a.index,
          )
          .slice(0, 1)
      : hits
  ).map((b) => b.index);
}
