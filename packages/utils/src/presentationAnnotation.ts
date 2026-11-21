/** Source spans keep every unselected byte intact when applying a visual comment. */
export interface SvgAnnotationElement {
  end: number;
  index: number;
  diagramId?: string;
  dataGroup?: { kind: 'table' | 'chart'; start: number };
  source: string;
  start: number;
  tag: string;
}
const atomicTags = new Set([
  'text',
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
/** The editor and server address SVG atoms in the same paint order. */
export function canvasAtoms(root: Element) {
  const atoms: Element[] = [];
  function visit(el: Element) {
    if (atomicTags.has(el.localName)) {
      atoms.push(el);
      return;
    }
    if (el.localName !== 'g' && el.localName !== 'svg') return;
    for (const child of Array.from(el.childNodes))
      if (child.nodeType === 1) visit(child as Element);
  }
  visit(root);
  return atoms;
}
export function canvasNode(root: Element, id: string): Element | undefined {
  if (id.startsWith('svg:')) return canvasAtoms(root)[Number(id.slice(4))];
  return Array.from(root.getElementsByTagName('g')).find(
    (n) =>
      n.getAttribute('data-scientific-diagram') === id || n.getAttribute('data-content-id') === id,
  );
}
interface DiagramSpan {
  id: string;
  start: number;
  end: number;
}
function indexSvg(
  svg: string,
  singleRoot = false,
  diagrams?: DiagramSpan[],
): SvgAnnotationElement[] {
  let hasRoot = false;
  const result: SvgAnnotationElement[] = [];
  const stack: {
    tag: string;
    start: number;
    selected: boolean;
    blocked: boolean;
    diagramId?: string;
    ownDiagramId?: string;
    dataGroup?: SvgAnnotationElement['dataGroup'];
  }[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  for (const match of svg.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith('<!')) continue;
    const tag = /^<\/?([\w:-]+)/.exec(token)![1];
    if (token.startsWith('</')) {
      const node = stack.pop();
      if (!node || node.tag !== tag) throw new Error('Invalid SVG nesting');
      if (node.ownDiagramId)
        diagrams?.push({
          id: node.ownDiagramId,
          start: node.start,
          end: match.index! + token.length,
        });
      if (node.selected)
        result.push({
          ...(node.diagramId ? { diagramId: node.diagramId } : {}),
          ...(node.dataGroup ? { dataGroup: node.dataGroup } : {}),
          start: node.start,
          end: match.index! + token.length,
          source: svg.slice(node.start, match.index! + token.length),
          tag,
          index: 0,
        });
      continue;
    }
    if (!stack.length) {
      if (singleRoot && hasRoot) throw new Error('Annotation replacement must be one SVG object');
      hasRoot = true;
    }
    const blocked =
      stack.some((n) => n.blocked || n.selected) ||
      ['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker'].includes(tag);
    const selected = !blocked && atomicTags.has(tag);
    let ownDiagramId: string | undefined;
    let dataGroup = stack.at(-1)?.dataGroup;
    if (tag === 'g' && token.includes('data-')) {
      const attributes = token.matchAll(/\s([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/gu);
      for (const [, name, , value] of attributes) {
        if (name === 'data-scientific-diagram' || name === 'data-content-id') ownDiagramId = value;
        if (name === 'data-report-table' && value === 'true')
          dataGroup = { kind: 'table', start: match.index! };
        if (name === 'data-pptx-replace-with' && (value === 'table' || value === 'chart'))
          dataGroup = { kind: value, start: match.index! };
      }
    }
    const node = {
      tag,
      start: match.index!,
      selected,
      blocked,
      diagramId: ownDiagramId ?? stack.at(-1)?.diagramId,
      ownDiagramId,
      dataGroup,
    };
    if (/\/\s*>$/.test(token)) {
      if (selected)
        result.push({
          ...(node.diagramId ? { diagramId: node.diagramId } : {}),
          ...(node.dataGroup ? { dataGroup: node.dataGroup } : {}),
          start: node.start,
          end: node.start + token.length,
          source: token,
          tag,
          index: 0,
        });
    } else stack.push(node);
  }
  if (stack.length) throw new Error('Unclosed SVG element');
  return result.sort((a, b) => a.start - b.start).map((node, index) => ({ ...node, index }));
}

// Ignore indentation between tspans, retaining each styled run and its exact position.
export function editableTextNodes(root: Node): Text[] {
  const result: Text[] = [];
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 && child.nodeValue?.trim()) result.push(child as Text);
      else if (child.nodeType === 1 && (child as Element).localName === 'tspan') visit(child);
    }
  };
  visit(root);
  return result;
}

export function annotationElements(svg: string): SvgAnnotationElement[] {
  return indexSvg(svg);
}

export function diagramSourceSpan(svg: string, blockId: string) {
  const diagrams: DiagramSpan[] = [];
  indexSvg(svg, false, diagrams);
  const matches = diagrams.filter((span) => span.id === blockId);
  return matches.length === 1 ? matches[0] : undefined;
}

export type AnnotationDataSelection =
  { kind: 'table' | 'chart'; blockId: string } | { kind: 'mixed' };

/** Editable tables and XY plots are projections of owned source data, including
 * their text, gridlines and markers. A visual fragment cannot edit that data.
 */
export function annotationDataSelection(
  elements: readonly SvgAnnotationElement[],
  indices: readonly number[],
  contentBlocks: unknown,
): AnnotationDataSelection | undefined {
  if (!indices.length) return undefined;
  const selected = new Set(indices.map((index) => elements[index]?.diagramId));
  for (const block of Array.isArray(contentBlocks) ? contentBlocks : []) {
    if (block?.kind !== 'scientific-diagram' || !selected.has(block.id)) continue;
    const spec = block.spec;
    const table = spec?.type === 'table';
    const chart =
      spec?.type === 'plot' &&
      !spec.equalAspect &&
      Array.isArray(spec.series) &&
      spec.series.length > 0 &&
      spec.series.every(
        (s: { points?: unknown; arrowEnd?: boolean }) =>
          s && !s.arrowEnd && Array.isArray(s.points) && s.points.length >= 2,
      );
    if (table || chart)
      return selected.size === 1
        ? { kind: table ? 'table' : 'chart', blockId: block.id }
        : { kind: 'mixed' };
  }
  // Older projections can retain an explicit data marker after losing their
  // editable source. Surface that state without inferring a table from shapes.
  const markers = indices.map((index) => elements[index]?.dataGroup);
  const marked = markers.find((marker) => marker !== undefined);
  if (marked)
    return markers.every((marker) => marker?.start === marked.start)
      ? { kind: marked.kind, blockId: '' }
      : { kind: 'mixed' };
}

export function mergeAnnotationElements(
  svg: string,
  indices: number[],
  patches: { index: number; svg: string }[],
): string {
  const elements = annotationElements(svg);
  const allowed = new Set(indices);
  if (
    !allowed.size ||
    allowed.size !== indices.length ||
    indices.some((i) => !Number.isInteger(i) || !elements[i])
  )
    throw new Error('Invalid annotation selection');
  if (
    !patches.length ||
    patches.length > indices.length ||
    new Set(patches.map((p) => p.index)).size !== patches.length
  )
    throw new Error('Invalid annotation patches');
  for (const patch of patches) {
    if (!allowed.has(patch.index) || typeof patch.svg !== 'string' || patch.svg.length > 100_000)
      throw new Error('Annotation changed an unselected element');
    // Local patches may define their own clip paths, but cannot reference definitions or
    // resources outside the replacement fragment.
    if (
      /<\s*(?:\/\s*)?(?:svg|style|script|foreignObject|filter|mask|animate\w*|set|a)\b|<!|\bon\w+\s*=|(?:javascript|data|https?):/i.test(
        patch.svg,
      )
    )
      throw new Error('Unsafe annotation patch');
    const localIds = new Set(
      [...patch.svg.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/gi)].map((match) => match[2]),
    );
    for (const reference of patch.svg.matchAll(/url\s*\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi)) {
      const value = reference[2];
      if (!value.startsWith('#') || !localIds.has(value.slice(1)))
        throw new Error('Unsafe annotation patch');
    }
    const allowedTags = new Set([
      'g',
      'defs',
      'clipPath',
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
    for (const tag of patch.svg.matchAll(/<\/?([\w:-]+)/g))
      if (!allowedTags.has(tag[1])) throw new Error('Unsupported annotation element');
    const nodes = indexSvg(patch.svg, true);
    if (
      !nodes.length ||
      !/^\s*<(?:g|text|image|rect|circle|ellipse|path|line|polyline|polygon|use)\b/.test(patch.svg)
    )
      throw new Error('Annotation patch must contain SVG elements');
  }
  let output = svg;
  for (const patch of [...patches].sort((a, b) => b.index - a.index)) {
    const element = elements[patch.index];
    output = output.slice(0, element.start) + patch.svg + output.slice(element.end);
  }
  return output;
}
