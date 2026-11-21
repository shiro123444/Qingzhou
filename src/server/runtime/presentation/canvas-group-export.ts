import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';

import { svgTextBounds } from './svg-text-bounds';

function readBox(value: string | null) {
  if (!value?.trim()) return;
  const box = value
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return box;
}

/** A hand-placed text frame can outgrow its original layout module while remaining on the slide. */
function fitCanvasTextModules(root: Element, placed: Set<unknown>) {
  const page = readBox(root.getAttribute('viewBox'));
  if (!page) return;
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== 1) continue;
    const group = node as Element;
    if (
      group.localName !== 'g' ||
      group.hasAttribute('data-pptx-placeholder') ||
      group.hasAttribute('data-pptx-replace-with')
    )
      continue;
    const bounds = readBox(group.getAttribute('data-pptx-bounds'));
    if (!bounds) continue;
    const [x, y, width, height] = bounds;
    let left = x,
      top = y,
      right = x + width,
      bottom = y + height;
    for (const text of Array.from(group.getElementsByTagName('text'))) {
      if (!placed.has(text.getAttribute('data-canvas-object'))) continue;
      for (const r of svgTextBounds(text, true)) {
        left = Math.min(left, Math.max(page[0], r.x));
        top = Math.min(top, Math.max(page[1], r.y));
        right = Math.max(right, Math.min(page[0] + page[2], r.x + r.width));
        bottom = Math.max(bottom, Math.min(page[1] + page[3], r.y + r.height));
      }
    }
    if (left !== x || top !== y || right !== x + width || bottom !== y + height)
      group.setAttribute('data-pptx-bounds', [left, top, right - left, bottom - top].join(' '));
  }
}

/** Export a canvas group as a real DrawingML group through PPT Master's SVG group converter. */
export function projectCanvasGroups(svg: string, canvasPlaced?: unknown) {
  const placed = new Set(
    Array.isArray(canvasPlaced) ? canvasPlaced.filter((id) => typeof id === 'string') : [],
  );
  if (!placed.size && !svg.includes('data-canvas-group=')) return svg;
  const document = parseString(svg);
  const root = document.documentElement;
  const members = Array.from(root.getElementsByTagName('*')).filter((n) =>
    n.hasAttribute('data-canvas-group'),
  );
  const groups = new Map<string, Element>();
  for (const member of members) {
    const path = member.getAttribute('data-canvas-group')!.split(' ').filter(Boolean);
    let parent: Element = root;
    for (const key of path) {
      let group = groups.get(key);
      if (!group) {
        group = document.createElement('g');
        group.setAttribute('id', key);
        groups.set(key, group);
        parent.appendChild(group);
      }
      parent = group;
    }
    // Preserve inherited styles, clips and transforms across the old layout layers.
    let branch = member;
    const ancestors: Element[] = [];
    for (let p = member.parentNode as Element; p && p !== root; p = p.parentNode as Element)
      ancestors.push(p);
    for (const ancestor of ancestors) {
      const wrapper = document.createElement('g');
      for (const attr of Array.from(ancestor.attributes)) {
        if (attr.name !== 'id' && !attr.name.startsWith('data-'))
          wrapper.setAttribute(attr.name, attr.value);
      }
      if (wrapper.attributes.length) {
        wrapper.appendChild(branch);
        branch = wrapper;
      }
    }
    parent.appendChild(branch);
  }
  if (placed.size) fitCanvasTextModules(root, placed);
  return document.toString();
}
