import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  CanvasCommand,
  PresentationSlidePlan,
} from '../../../../packages/runtime-contracts/src';
import { scaleInPage, translateInPage } from '../../../utils/presentationCanvasTransform';
import { canvasAtoms, canvasNode } from '../../../../packages/utils/src/presentationAnnotation';
import { pasteContentLayer } from './native-data-export';
import { renderScientificDiagram, semanticBlockSchema } from './semantic-blocks';

const id = z.string().min(1).max(160);
const object = z.string().regex(/^(?:svg:\d+|[\w-]{1,80})$/);
const delta = z.number().finite().min(-5000).max(5000);
const selection = z.array(object).min(2).max(512);
const base = { expectedVersionId: id };
export const canvasCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('restore'),
      version: id,
      direction: z.enum(['undo', 'redo']),
      operationId: id,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('paste'),
      sourceVersion: id,
      sourcePage: z.number().int().positive(),
      object,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('moveMany'),
      moves: z
        .array(z.object({ object, dx: delta, dy: delta }).strict())
        .min(2)
        .max(512),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('pasteMany'),
      objects: selection,
      sourceVersion: id,
      sourcePage: z.number().int().positive(),
      dx: delta,
      dy: delta,
    })
    .strict(),
  z.object({ ...base, kind: z.literal('group'), objects: selection }).strict(),
  z.object({ ...base, kind: z.literal('ungroup'), objects: selection }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('resizeGroup'),
      objects: selection,
      anchorX: delta,
      anchorY: delta,
      factor: z.number().finite().positive().max(20),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('removeMany'), objects: selection }).strict(),
  z.object({ ...base, kind: z.literal('remove'), object }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('translate'),
      object,
      dx: z.number().finite().min(-5000).max(5000),
      dy: z.number().finite().min(-5000).max(5000),
    })
    .strict(),
]);
type LoadPage = (version: string, page: number) => Promise<PresentationSlidePlan>;
export async function editCanvasPage(
  slide: PresentationSlidePlan,
  number: number,
  command: CanvasCommand,
  requestId: string,
  load: LoadPage,
): Promise<PresentationSlidePlan> {
  if (command.kind === 'restore') {
    const old = await load(command.version, number);
    if (old.slideId !== slide.slideId) throw Error('页面版本不匹配');
    return { ...old, order: slide.order, slideId: slide.slideId };
  }
  const paste = command.kind === 'paste' || command.kind === 'pasteMany' ? command : undefined;
  const source = paste ? await load(paste.sourceVersion, paste.sourcePage) : slide;
  const doc = parseString(slide.svg);
  const original = paste ? parseString(source.svg) : doc;
  const ids =
    command.kind === 'moveMany'
      ? command.moves.map((m) => m.object)
      : 'objects' in command
        ? command.objects
        : [command.object];
  if (new Set(ids).size !== ids.length) throw Error('同一对象不能重复加入操作');
  const blocks = [
    ...(Array.isArray(slide.metadata?.contentBlocks) ? slide.metadata.contentBlocks : []),
  ];
  const sourceBlocks = Array.isArray(source.metadata?.contentBlocks)
    ? source.metadata.contentBlocks
    : [];
  const paintOrder = new Map(
    Array.from(original.documentElement.getElementsByTagName('*')).map((node, index) => [
      node,
      index,
    ]),
  );
  const atoms = canvasAtoms(original.documentElement);
  // Capture every reference before removing atoms or inserting rendered table rows.
  const targets = ids
    .map((id, i) => {
      const raw = id.startsWith('svg:');
      const node = raw ? atoms[Number(id.slice(4))] : canvasNode(original.documentElement, id);
      if (!node || node.getAttribute('data-pptx-role') === 'background')
        throw Error('所选对象已变化');
      if (raw) {
        for (
          let parent = node.parentNode as Element;
          parent?.getAttribute;
          parent = parent.parentNode as Element
        )
          if (
            parent.getAttribute('data-scientific-diagram') ||
            parent.getAttribute('data-content-id')
          )
            throw Error('请选择完整的数据对象');
      }
      const block = raw
        ? undefined
        : semanticBlockSchema.parse(sourceBlocks.find((b) => b.id === id));
      const offset =
        command.kind === 'moveMany'
          ? command.moves[i]
          : 'dx' in command
            ? command
            : { dx: 12, dy: 12 };
      return { id, node, block, dx: offset.dx, dy: offset.dy };
    })
    .sort((a, b) => paintOrder.get(a.node)! - paintOrder.get(b.node)!);
  const groupAttr = 'data-canvas-group';
  const groupName = (key: string) =>
    'canvas-group-' +
    createHash('sha256')
      .update(requestId + ':' + key)
      .digest('hex')
      .slice(0, 16);
  const membership = (node: Element) =>
    (node.getAttribute(groupAttr) ?? '').split(' ').filter(Boolean);
  const members = new Set(targets.map((t) => t.node));
  const groups = new Set(targets.map((t) => membership(t.node)[0]).filter(Boolean));
  if (
    groups.size &&
    Array.from(original.getElementsByTagName('*')).some(
      (n) => groups.has(membership(n)[0]) && !members.has(n),
    )
  )
    throw Error('请选择完整组合');
  if (command.kind === 'moveMany') {
    const offsets = new Map<string, { dx: number; dy: number }>();
    for (const target of targets) {
      const owner = membership(target.node)[0];
      if (!owner) continue;
      const existing = offsets.get(owner);
      if (
        existing &&
        (Math.abs(existing.dx - target.dx) > 1e-7 || Math.abs(existing.dy - target.dy) > 1e-7)
      )
        throw Error('组合成员必须一起移动');
      offsets.set(owner, target);
    }
  }
  if (
    command.kind === 'ungroup' &&
    (groups.size !== 1 || targets.some((t) => !membership(t.node).length))
  )
    throw Error('请选择一个组合');
  const selected: (Element | string)[] = [];
  const bounds = doc.documentElement
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  const groupLayer =
    command.kind === 'pasteMany' && bounds?.length === 4
      ? pasteContentLayer(doc.documentElement, {
          x: bounds[0],
          y: bounds[1],
          width: bounds[2],
          height: bounds[3],
        })
      : undefined;
  for (const [index, { id, node, block, dx, dy }] of targets.entries()) {
    if (command.kind === 'remove' || command.kind === 'removeMany') {
      node.parentNode!.removeChild(node);
      if (block)
        blocks.splice(
          blocks.findIndex((b) => b.id === id),
          1,
        );
      continue;
    }
    const path = membership(node);
    if (command.kind === 'group' || command.kind === 'ungroup') {
      const next = command.kind === 'group' ? [groupName('group'), ...path] : path.slice(1);
      if (next.length) node.setAttribute(groupAttr, next.join(' '));
      else node.removeAttribute(groupAttr);
      selected.push(block ? id : node);
      continue;
    }
    const groupPath = paste ? path.map(groupName) : path;
    const copying = !!paste;
    const token = ids.length === 1 ? requestId : requestId + ':' + index;
    const newId = copying
      ? 'copy-' + createHash('sha256').update(token).digest('hex').slice(0, 12)
      : id;
    if (block) {
      let x = block.rect.x + dx,
        y = block.rect.y + dy;
      if (command.kind === 'paste' && bounds?.length === 4) {
        x = Math.max(bounds[0], Math.min(x, bounds[0] + bounds[2] - block.rect.width));
        y = Math.max(bounds[1], Math.min(y, bounds[1] + bounds[3] - block.rect.height));
      }
      const factor = command.kind === 'resizeGroup' ? command.factor : 1;
      if (command.kind === 'resizeGroup') {
        x = command.anchorX + (block.rect.x - command.anchorX) * factor;
        y = command.anchorY + (block.rect.y - command.anchorY) * factor;
      }
      const width = block.rect.width * factor,
        height = block.rect.height * factor;
      const updated = { ...block, id: newId, rect: { x, y, width, height } };
      if (factor !== 1 && updated.kind === 'scientific-diagram')
        updated.canvasScale = (updated.canvasScale ?? 1) * factor;
      if (factor !== 1 && updated.kind === 'formula') updated.fontSize *= factor;
      semanticBlockSchema.parse(updated);
      if (
        bounds?.length === 4 &&
        (x < bounds[0] - 0.01 ||
          y < bounds[1] - 0.01 ||
          x + width > bounds[0] + bounds[2] + 0.01 ||
          y + height > bounds[1] + bounds[3] + 0.01)
      )
        throw Error('所选组件超出页面');
      const markup =
        updated.kind === 'scientific-diagram'
          ? renderScientificDiagram(updated)
          : await (await import('./formula-renderer')).renderFormula(updated);
      const rendered = doc.importNode(
        parseString(
          '<svg xmlns="http://www.w3.org/2000/svg">' + markup + '</svg>',
        ).getElementsByTagName('g')[0],
        true,
      );
      if (groupPath.length) rendered.setAttribute(groupAttr, groupPath.join(' '));
      if (copying) {
        (groupLayer ?? pasteContentLayer(doc.documentElement, updated.rect)).appendChild(rendered);
        blocks.push(updated);
      } else {
        const parent = node.parentNode as Element;
        if (
          parent
            .getAttribute('data-pptx-bounds')
            ?.trim()
            .split(/[\s,]+/u)
            .map(Number)
            .join(' ') ===
            [block.rect.x, block.rect.y, block.rect.width, block.rect.height].join(' ') &&
          Array.from(parent.childNodes).filter((n) => n.nodeType === 1).length === 1
        )
          parent.setAttribute('data-pptx-bounds', [x, y, width, height].join(' '));
        parent.replaceChild(rendered, node);
        blocks[blocks.findIndex((b) => b.id === id)] = updated;
      }
      selected.push(newId);
    } else if (copying) {
      const { group, copy } = cloneCanvasAtom(doc, original, node, newId, dx, dy);
      (groupLayer ?? doc.documentElement).appendChild(group);
      if (groupPath.length) copy.setAttribute(groupAttr, groupPath.join(' '));
      selected.push(copy);
    } else {
      if (command.kind === 'resizeGroup') {
        scaleInPage(node, command.anchorX, command.anchorY, command.factor);
        node.setAttribute(
          'data-canvas-scale',
          String(Number(node.getAttribute('data-canvas-scale') || 1) * command.factor),
        );
      } else translateInPage(node, dx, dy);
      selected.push(node);
    }
  }
  const finalAtoms = canvasAtoms(doc.documentElement);
  const arrangements = Array.isArray(slide.metadata?.canvasArrangements)
    ? slide.metadata.canvasArrangements.filter(
        (g): g is string[] => Array.isArray(g) && g.every((k) => typeof k === 'string'),
      )
    : [];
  if (selected.length > 1) {
    const keys = selected.map((item, index) => {
      if (typeof item === 'string') return item;
      let key = item.getAttribute('data-canvas-object');
      if (!key || paste) {
        key =
          'atom-' +
          createHash('sha256')
            .update(requestId + ':' + index)
            .digest('hex')
            .slice(0, 16);
        item.setAttribute('data-canvas-object', key);
      }
      return key;
    });
    if (!arrangements.some((g) => keys.every((k) => g.includes(k)))) arrangements.push(keys);
  }
  const live = new Set([
    ...finalAtoms.map((node) => node.getAttribute('data-canvas-object')),
    ...blocks.map((b) => b.id),
  ]);
  const liveGroups = arrangements
    .map((g) => g.filter((k) => live.has(k)))
    .filter((g) => g.length > 1);
  return {
    ...slide,
    svg: doc.toString(),
    metadata: {
      ...slide.metadata,
      ...(Array.isArray(slide.metadata?.contentBlocks) || blocks.length
        ? { contentBlocks: blocks }
        : {}),
      ...(arrangements.length ? { canvasArrangements: liveGroups } : {}),
      canvasSelection: {
        requestId,
        ids: selected.map((item) =>
          typeof item === 'string' ? item : 'svg:' + finalAtoms.indexOf(item),
        ),
      },
    },
  };
}

/** Record the objects the user placed by hand. Use stable keys so later insertions,
 * pastes and undo cannot transfer overlap permission to an unrelated object. */
export function recordCanvasPlacement(
  slide: PresentationSlidePlan,
  requestId: string,
  ids: string[],
) {
  const receipt = slide.metadata?.canvasSelection as { requestId?: string } | undefined;
  if (receipt?.requestId !== requestId || !ids.length) return slide;
  const doc = parseString(slide.svg);
  const placed = new Set<string>(
    Array.isArray(slide.metadata?.canvasPlaced)
      ? slide.metadata.canvasPlaced.filter((id): id is string => typeof id === 'string')
      : [],
  );
  let changed = false;
  for (const id of ids) {
    const node = canvasNode(doc.documentElement, id);
    if (!node) continue;
    let key = id;
    if (id.startsWith('svg:')) {
      key =
        node.getAttribute('data-canvas-object') ||
        'atom-' +
          createHash('sha256')
            .update(requestId + ':' + id)
            .digest('hex')
            .slice(0, 16);
      if (!node.hasAttribute('data-canvas-object')) {
        node.setAttribute('data-canvas-object', key);
        changed = true;
      }
    }
    if (!placed.has(key)) {
      placed.add(key);
      changed = true;
    }
  }
  return changed
    ? { ...slide, svg: doc.toString(), metadata: { ...slide.metadata, canvasPlaced: [...placed] } }
    : slide;
}

function cloneCanvasAtom(
  doc: Document,
  original: Document,
  node: Element,
  newId: string,
  dx: number,
  dy: number,
) {
  const copy = doc.importNode(node, true);
  copy.removeAttribute('data-canvas-object');
  // Keep inherited presentation attributes. IDs and definitions must remain local to this copy.
  let branch = copy;
  for (
    let parent = node.parentNode as Element;
    parent?.localName === 'g';
    parent = parent.parentNode as Element
  ) {
    const ancestor = doc.importNode(parent, false);
    ancestor.removeAttribute('id');
    for (const attr of Array.from(ancestor.attributes))
      if (attr.name.startsWith('data-')) ancestor.removeAttribute(attr.name);
    ancestor.appendChild(branch);
    branch = ancestor;
  }
  const group = doc.createElement('g');
  group.setAttribute('transform', `translate(${dx} ${dy})`);
  group.appendChild(branch);
  const defs = doc.createElement('defs'),
    known = new Set<string>();
  const elements = (root: Element) => [root, ...Array.from(root.getElementsByTagName('*'))];
  const sources = new Map(
    elements(original.documentElement)
      .filter((e) => e.hasAttribute('id'))
      .map((e) => [e.getAttribute('id')!, e]),
  );
  function refs(root: Element) {
    for (const el of elements(root))
      for (const attr of Array.from(el.attributes)) {
        const ids = [...attr.value.matchAll(/url\(\s*['"]?#([^)'"]+)['"]?\s*\)/g)].map((m) => m[1]);
        if (attr.localName === 'href' && attr.value.startsWith('#')) ids.push(attr.value.slice(1));
        for (const key of ids) {
          if (known.has(key)) continue;
          known.add(key);
          const def = sources.get(key);
          if (!def || elements(group).some((n) => n.getAttribute('id') === key)) continue;
          const cloned = doc.importNode(def, true);
          defs.appendChild(cloned);
          refs(cloned);
        }
      }
  }
  refs(group);
  if (defs.firstChild) group.insertBefore(defs, group.firstChild);
  for (const el of elements(group))
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'id') el.setAttribute('id', newId + '-' + attr.value);
      else if (
        attr.value.includes('url(') ||
        (attr.localName === 'href' && attr.value.startsWith('#'))
      )
        el.setAttribute(
          attr.name,
          attr.value.replace(
            /(url\(\s*['"]?#|^#)([\w:.-]+)/g,
            (_, prefix, id) => prefix + newId + '-' + id,
          ),
        );
    }
  return { group, copy };
}
