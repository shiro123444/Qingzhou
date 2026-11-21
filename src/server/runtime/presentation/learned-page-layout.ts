import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { isLearnedFooter } from './learned-layout-primitives';
import { compileLearnedMediaLayout } from './learned-media-layout';
import { compileLearnedNativeLayout } from './learned-native-layout';

type Input = Parameters<typeof compileLearnedNativeLayout>[0] & {
  imageSizes?: ReadonlyMap<string, { width: number; height: number }>;
};

/** A standalone exhibit can have source notes and conclusions outside its data
 * subtree. Keep that prose when moving its carrier into a learned source slot. */
function exhibitCopy(input: Input, document: XMLDocument) {
  const values = new Set(input.approvedContent ?? []);
  const known = (s: string) => s.replaceAll(/\s/gu, '');
  for (const group of Array.from(document.getElementsByTagName('g'))) {
    const value = group.getAttribute('data-source-paragraph');
    if (value) values.add(value);
  }
  for (const text of Array.from(document.getElementsByTagName('text'))) {
    let inside = false;
    for (let node = text.parentNode; node?.nodeType === 1; node = node.parentNode) {
      const group = node as Element;
      if (
        ['data-scientific-diagram', 'data-content-id', 'data-source-paragraph'].some((key) =>
          group.hasAttribute(key),
        )
      ) {
        inside = true;
        break;
      }
    }
    if (inside) continue;
    const value = text.textContent?.trim();
    if (!value || [...values, input.title].some((line) => known(line) === known(value))) continue;
    const size = Number.parseFloat(text.getAttribute('font-size') ?? '16');
    if (size >= 28 && known(input.title).includes(known(value))) continue;
    if (
      isLearnedFooter(
        { text: value, y: Number(text.getAttribute('y')), size },
        input.system!.height,
        input.pageNumber,
        input.totalPages,
        input.deckTitle,
      )
    )
      continue;
    values.add(value);
  }
  return [...values];
}

export async function compileLearnedPageLayout(input: Input) {
  const blocks = Array.isArray(input.rawBlocks) ? input.rawBlocks : [];
  if (input.system?.schemaVersion !== 3) return compileLearnedNativeLayout(input);
  const document = parseString(input.svg);
  const mixed =
    blocks.length > 1 ||
    blocks.some((b) => b?.kind === 'formula') ||
    document.getElementsByTagName('image').length > 0;
  if (mixed) return compileLearnedMediaLayout({ ...input, system: input.system });
  const exhibitType =
    blocks.length === 1 && blocks[0]?.kind === 'scientific-diagram'
      ? blocks[0].spec?.type
      : undefined;
  if (exhibitType === 'table') {
    let reason: string | undefined;
    const native = compileLearnedNativeLayout({
      ...input,
      onSkip: (skip) => {
        reason = skip;
      },
    });
    if (native) return native;
    if (reason !== 'no-compatible-source-layout') {
      if (reason) input.onSkip?.(reason);
      return;
    }
  } else if (!['plot', 'radar', 'taylor', 'quadratic'].includes(exhibitType)) {
    return compileLearnedNativeLayout(input);
  }
  return compileLearnedMediaLayout({
    ...input,
    exhibitCopy: exhibitCopy(input, document),
    system: input.system,
  });
}
