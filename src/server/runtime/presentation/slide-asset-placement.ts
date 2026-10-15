import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationAssetPlacement } from './revision-assets';

const SVG = 'http://www.w3.org/2000/svg';

/** Place owned assets in slide coordinates, preserving separate editable text and clipped image layers. */
export function composePresentationAssets(
  svg: string,
  assets: readonly { href: string; layout: PresentationAssetPlacement }[],
): string {
  if (!assets.length) return svg;
  const document = parseString(svg);
  const root = document.documentElement;
  const viewport = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (
    viewport.length !== 4 ||
    viewport.some((value) => !Number.isFinite(value)) ||
    viewport[2] <= 0 ||
    viewport[3] <= 0
  )
    throw new Error('Image layout requires a finite SVG viewBox');
  const [x, y, width, height] = viewport;
  const ownedHrefs = new Set(assets.map((asset) => asset.href.replace(/\?raw=true$/u, '')));
  for (const image of Array.from(root.getElementsByTagName('image'))) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    if (ownedHrefs.has(href.replace(/\?raw=true$/u, ''))) image.parentNode?.removeChild(image);
  }
  const existingIds = new Set(
    Array.from(document.getElementsByTagName('*')).map((element) => element.getAttribute('id')),
  );
  let defs = Array.from(root.childNodes).find(
    (node) => node.nodeType === 1 && node.nodeName === 'defs',
  );
  if (!defs) {
    defs = document.createElementNS(SVG, 'defs');
    root.insertBefore(defs, root.firstChild);
  }
  const children = Array.from(root.childNodes).filter(
    (node) => node.nodeType === 1 && !['defs', 'title', 'desc', 'metadata'].includes(node.nodeName),
  );
  const firstContent = children.find((node) => {
    const element = node as typeof root;
    const scalar = (value: string | null, extent: number, origin = 0) =>
      value?.trim().endsWith('%')
        ? origin + (Number.parseFloat(value) * extent) / 100
        : Number(value || 0);
    // Leave the slide's solid base fill behind the owned background artwork.
    return (
      element.nodeName !== 'rect' ||
      scalar(element.getAttribute('x'), width, x) !== x ||
      scalar(element.getAttribute('y'), height, y) !== y ||
      scalar(element.getAttribute('width'), width) !== width ||
      scalar(element.getAttribute('height'), height) !== height
    );
  });
  const textAnchor = children.find(
    (node) => node.nodeName === 'text' || (node as typeof root).getElementsByTagName('text').length,
  );
  if (textAnchor && assets.some(({ layout }) => (layout.layer ?? 'content') === 'content')) {
    // Native card fills/placeholders written after the title must stay below subject
    // imagery. Keep text-bearing groups above it without inheriting their transforms.
    for (const node of children) {
      if (node === textAnchor || node.nodeName === 'text' ||
          (node as typeof root).getElementsByTagName('text').length) continue;
      root.insertBefore(node, textAnchor);
    }
  }
  const layerOrder = { background: 0, content: 1, foreground: 2 };
  const ordered = assets.toSorted(
    (a, b) =>
      layerOrder[a.layout.layer ?? 'content'] - layerOrder[b.layout.layer ?? 'content'] ||
      (a.layout.zIndex ?? 0) - (b.layout.zIndex ?? 0),
  );
  for (const [index, asset] of ordered.entries()) {
    const { layout, href } = asset;
    const image = document.createElementNS(SVG, 'image');
    image.setAttribute('href', href);
    image.setAttribute('x', String(x + layout.x * width));
    image.setAttribute('y', String(y + layout.y * height));
    image.setAttribute('width', String(layout.width * width));
    image.setAttribute('height', String(layout.height * height));
    image.setAttribute(
      'preserveAspectRatio',
      `xMidYMid ${layout.fit === 'cover' ? 'slice' : 'meet'}`,
    );
    let id = `presentation-asset-clip-${index}`;
    while (existingIds.has(id)) id += '-next';
    existingIds.add(id);
    const clip = document.createElementNS(SVG, 'clipPath');
    clip.setAttribute('id', id);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const region = document.createElementNS(SVG, 'rect');
    for (const attribute of ['x', 'y', 'width', 'height'])
      region.setAttribute(attribute, image.getAttribute(attribute)!);
    clip.appendChild(region);
    defs.appendChild(clip);
    image.setAttribute('clip-path', `url(#${id})`);
    image.setAttribute('data-presentation-layer', layout.layer ?? 'content');
    root.insertBefore(
      image,
      layout.layer === 'background'
        ? (firstContent ?? null)
        : layout.layer === 'foreground'
          ? null
          : (textAnchor ?? null),
    );
  }
  return document.toString();
}
