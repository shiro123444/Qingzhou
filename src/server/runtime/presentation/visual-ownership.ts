import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationSlidePlan } from '../../../../packages/runtime-contracts/src';
import { assetPlacementBox, overlayAssetAnnotations } from './asset-annotations';
import { isNativeVisual, readVisualAssetBindings, visualRequirementSchema } from './content-intent';
import { semanticBlockSchema } from './semantic-blocks';
import { measureSlideText } from './text-measurement';

const canonicalRef = (ref: string) => ref.replace(/\?raw=true$/u, '');

/** A self-contained diagram never keeps a second set of vector labels on retry. */
export function reconcileEmbeddedVisualAnnotations(
  slide: PresentationSlidePlan,
): PresentationSlidePlan {
  if (!Array.isArray(slide.metadata?.visualRequirements)) return slide;
  const assets = slide.metadata.visualRequirements.flatMap((value) => {
    const parsed = visualRequirementSchema.safeParse(value);
    return parsed.success && parsed.data.annotationMode === 'embedded'
      ? [{ annotationMode: 'embedded' as const, visualId: parsed.data.id }]
      : [];
  });
  if (!assets.length) return slide;
  const svg = overlayAssetAnnotations(slide.svg, [], assets);
  return svg === slide.svg ? slide : { ...slide, svg };
}

/** One visual ID has one representation. A verified native replacement retires its old bitmap. */
export function reconcileNativeVisualAssets(slide: PresentationSlidePlan): PresentationSlidePlan {
  const metadata = slide.metadata;
  if (!Array.isArray(metadata?.visualRequirements) || !Array.isArray(metadata?.contentBlocks))
    return slide;
  const contentBlocks = metadata.contentBlocks;
  const document = parseString(slide.svg);
  const groups = Array.from(document.getElementsByTagName('g'));
  const native = new Set(
    metadata.visualRequirements.flatMap((value) => {
      const parsed = visualRequirementSchema.safeParse(value);
      if (!parsed.success || !isNativeVisual(parsed.data) || parsed.data.kind === 'source-figure')
        return [];
      const id = parsed.data.id;
      const rendered = groups.some((group) => group.getAttribute('data-scientific-diagram') === id);
      const hasSource = contentBlocks.some((value: unknown) => {
        const block = semanticBlockSchema.safeParse(value);
        return block.success && block.data.kind === 'scientific-diagram' && block.data.id === id;
      });
      return rendered && hasSource ? [id] : [];
    }),
  );
  const bindings = readVisualAssetBindings(metadata.visualAssets);
  const active = bindings.filter((binding) => !native.has(binding.visualId));
  const retired = new Set(
    bindings
      .filter(
        (binding) =>
          native.has(binding.visualId) &&
          !active.some((other) => canonicalRef(other.ref) === canonicalRef(binding.ref)),
      )
      .map((binding) => canonicalRef(binding.ref)),
  );
  if (active.length === bindings.length) return slide;
  for (const image of Array.from(document.getElementsByTagName('image'))) {
    const ref = image.getAttribute('href') ?? image.getAttribute('xlink:href');
    if (ref && retired.has(canonicalRef(ref))) image.parentNode?.removeChild(image);
  }
  for (const group of groups) {
    if (native.has(group.getAttribute('data-asset-annotations') ?? ''))
      group.parentNode?.removeChild(group);
  }
  return {
    ...slide,
    svg: document.toString(),
    metadata: {
      ...metadata,
      visualAssets: active,
      ...(Array.isArray(metadata.generatedAssetRefs)
        ? {
            generatedAssetRefs: metadata.generatedAssetRefs.filter(
              (ref: unknown) =>
                typeof ref !== 'string' ||
                !retired.has(
                  canonicalRef(
                    ref.startsWith('/') ? ref : `/api/runtime/presentation/artifacts/${ref}`,
                  ),
                ),
            ),
          }
        : {}),
    },
  };
}

/** Shared occupied regions: semantic nodes, foreground images and authored text. */
export function inspectVisualOccupancy(
  slide: PresentationSlidePlan,
  imageSizes: ReadonlyMap<string, { width: number; height: number }> = new Map(),
): string[] {
  const document = parseString(slide.svg);
  const raw = slide.metadata?.contentBlocks;
  const blocks = (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const parsed = semanticBlockSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const bindings = readVisualAssetBindings(slide.metadata?.visualAssets);
  if (!blocks.length && !bindings.length) return [];
  type Region = { x: number; y: number; width: number; height: number };
  const intersects = (a: Region, b: Region) =>
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2;
  const hasAncestor = (element: Element, attribute: string): boolean => {
    for (
      let node: Element | null = element;
      node;
      node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
    )
      if (node.hasAttribute(attribute)) return true;
    return false;
  };
  const inherited = (element: Element, attribute: string): string | undefined => {
    for (
      let node: Element | null = element;
      node;
      node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
    )
      if (node.hasAttribute(attribute)) return node.getAttribute(attribute)!;
    return undefined;
  };
  // Common card layouts use translated/scaled groups and multiline tspans.
  // They must participate in occupancy checks just like untransformed text.
  const worldRect = (element: Element, rect: Region): Region | undefined => {
    const transforms: string[] = [];
    for (
      let node: Element | null = element;
      node;
      node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
    )
      if (node.hasAttribute('transform')) transforms.unshift(node.getAttribute('transform')!);
    let sx = 1,
      sy = 1,
      tx = 0,
      ty = 0;
    for (const transform of transforms) {
      const operations = [...transform.matchAll(/([a-z]+)\s*\(([^)]*)\)/giu)];
      if (transform.replaceAll(/([a-z]+)\s*\(([^)]*)\)/giu, '').trim()) return undefined;
      for (const [, name, arguments_] of operations) {
        const values = arguments_
          .trim()
          .split(/[\s,]+/u)
          .map(Number);
        if (!values.length || !values.every(Number.isFinite)) return undefined;
        if (name === 'translate' && values.length <= 2) {
          tx += sx * values[0];
          ty += sy * (values[1] ?? 0);
        } else if (name === 'scale' && values.length <= 2) {
          sx *= values[0];
          sy *= values[1] ?? values[0];
        } else return undefined;
      }
    }
    const x1 = tx + sx * rect.x,
      x2 = tx + sx * (rect.x + rect.width);
    const y1 = ty + sy * rect.y,
      y2 = ty + sy * (rect.y + rect.height);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  };
  const images = Array.from(document.getElementsByTagName('image')).flatMap((image) => {
    const ref = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    const binding = bindings.find((item) => canonicalRef(item.ref) === canonicalRef(ref));
    if (!binding || hasAncestor(image, 'transform')) return [];
    const rect = Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key) => {
        const value = image.getAttribute(key) ?? (key === 'x' || key === 'y' ? '0' : '');
        return [key, /^-?\d+(?:\.\d+)?(?:px)?$/u.test(value) ? Number.parseFloat(value) : NaN];
      }),
    ) as Region;
    if (!Object.values(rect).every(Number.isFinite)) return [];
    const size = imageSizes.get(canonicalRef(ref));
    const painted = size
      ? assetPlacementBox(
          [0, 0, 1, 1],
          rect,
          size,
          image.getAttribute('preserveAspectRatio') || undefined,
        )
      : rect;
    // A cover image is cropped to the viewport; contain margins are unoccupied.
    const occupied = {
      x: Math.max(rect.x, painted.x),
      y: Math.max(rect.y, painted.y),
      width: Math.min(rect.x + rect.width, painted.x + painted.width) - Math.max(rect.x, painted.x),
      height:
        Math.min(rect.y + rect.height, painted.y + painted.height) - Math.max(rect.y, painted.y),
    };
    return [{ id: binding.visualId, rect: occupied }];
  });
  const issues: string[] = [];
  for (const image of images)
    for (const block of blocks)
      if (intersects(image.rect, block.rect))
        issues.push(`Image ${image.id} overlaps content block ${block.id}`);
  for (const text of Array.from(document.getElementsByTagName('text'))) {
    if (
      hasAncestor(text, 'data-content-id') ||
      hasAncestor(text, 'data-scientific-diagram') ||
      hasAncestor(text, 'data-formula-latex') ||
      hasAncestor(text, 'data-asset-annotations')
    )
      continue;
    const spans = Array.from(text.getElementsByTagName('tspan')).filter(
      (span) => !span.getElementsByTagName('tspan').length,
    );
    let x = Number.parseFloat(text.getAttribute('x') ?? '0');
    let y = Number.parseFloat(text.getAttribute('y') ?? '0');
    for (const run of spans.length ? spans : [text]) {
      if (run.hasAttribute('x')) x = Number.parseFloat(run.getAttribute('x')!);
      if (run.hasAttribute('y')) y = Number.parseFloat(run.getAttribute('y')!);
      x += Number.parseFloat(run.getAttribute('dx') ?? '0');
      y += Number.parseFloat(run.getAttribute('dy') ?? '0');
      const size = Number.parseFloat(inherited(run, 'font-size') ?? '');
      if (![size, x, y].every(Number.isFinite) || !run.textContent?.trim()) continue;
      const width = measureSlideText(
        run.textContent,
        size,
        inherited(run, 'font-family'),
        inherited(run, 'font-weight'),
      );
      const anchor = inherited(run, 'text-anchor');
      const rect = worldRect(run, {
        x: x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0),
        y: y - size * 0.8,
        width,
        height: size,
      });
      x += width;
      if (!rect) continue;
      for (const block of blocks)
        if (intersects(rect, block.rect)) issues.push(`Text overlaps content block ${block.id}`);
      for (const image of images)
        if (intersects(rect, image.rect)) issues.push(`Text overlaps image ${image.id}`);
    }
  }
  return [...new Set(issues)];
}
