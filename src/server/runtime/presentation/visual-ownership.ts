import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type { PresentationSlidePlan } from '../../../../packages/runtime-contracts/src';
import { isNativeVisual, readVisualAssetBindings, visualRequirementSchema } from './content-intent';
import { semanticBlockSchema } from './semantic-blocks';
import { measureSlideText } from './text-measurement';

const canonicalRef = (ref: string) => ref.replace(/\?raw=true$/u, '');

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
export function inspectVisualOccupancy(slide: PresentationSlidePlan): string[] {
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
    return Object.values(rect).every(Number.isFinite) ? [{ id: binding.visualId, rect }] : [];
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
      hasAncestor(text, 'data-asset-annotations') ||
      hasAncestor(text, 'transform') ||
      text.getElementsByTagName('tspan').length
    )
      continue;
    const size = Number.parseFloat(text.getAttribute('font-size') ?? '');
    const x = Number.parseFloat(text.getAttribute('x') ?? '');
    const y = Number.parseFloat(text.getAttribute('y') ?? '');
    if (![size, x, y].every(Number.isFinite) || !text.textContent?.trim()) continue;
    const width = measureSlideText(
      text.textContent,
      size,
      text.getAttribute('font-family') ?? undefined,
      text.getAttribute('font-weight') ?? undefined,
    );
    const anchor = text.getAttribute('text-anchor');
    const rect = {
      x: x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0),
      y: y - size * 0.8,
      width,
      height: size,
    };
    for (const block of blocks)
      if (intersects(rect, block.rect)) issues.push(`Text overlaps content block ${block.id}`);
    for (const image of images)
      if (intersects(rect, image.rect)) issues.push(`Text overlaps image ${image.id}`);
  }
  return [...new Set(issues)];
}
