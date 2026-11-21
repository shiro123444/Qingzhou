import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';

const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export function parseExportFontMap(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 100 ||
    Object.entries(value).some(
      ([source, target]) =>
        !source.trim() ||
        source.length > 200 ||
        typeof target !== 'string' ||
        !target.trim() ||
        target.length > 200 ||
        Array.from(source + target).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new Error('CORDIS_PRESENTATION_EXPORT_FONT_MAP must map font names to font names');
  return value as Readonly<Record<string, string>>;
}

/** SVG has already positioned its lines. Office must not reflow them during import. */
export function preserveSvgTextLayout(
  bytes: Uint8Array,
  fontMap: Readonly<Record<string, string>> = {},
): Uint8Array {
  const files = unzipSync(bytes);
  let changed = false;
  for (const name of Object.keys(files)) {
    const isSlide = /^ppt\/slides\/slide\d+\.xml$/u.test(name);
    if (!isSlide && !/^ppt\/(?:theme|slideMasters|slideLayouts)\/[^/]+\.xml$/u.test(name)) continue;
    const document = parseString(strFromU8(files[name]));
    let slideChanged = false;
    for (const tag of ['latin', 'ea', 'cs', 'font']) {
      for (const element of Array.from(document.getElementsByTagNameNS(DRAWING, tag))) {
        const face = element.getAttribute('typeface');
        const replacement = face && Object.hasOwn(fontMap, face) ? fontMap[face] : undefined;
        if (replacement && replacement !== face) {
          element.setAttribute('typeface', replacement);
          slideChanged = true;
        }
      }
    }
    for (const body of Array.from(document.getElementsByTagNameNS(DRAWING, 'bodyPr'))) {
      if (!isSlide) continue;
      if (body.getAttribute('wrap') !== 'none') continue;
      for (const child of Array.from(body.childNodes)) {
        if (child.nodeType !== 1) continue;
        const element = child as Element;
        if (element.namespaceURI !== DRAWING || element.localName !== 'spAutoFit') continue;
        body.replaceChild(
          document.createElementNS(
            DRAWING,
            `${element.prefix ? `${element.prefix}:` : ''}noAutofit`,
          ),
          child,
        );
        slideChanged = true;
      }
    }
    if (slideChanged) {
      files[name] = strToU8(document.toString());
      changed = true;
    }
  }
  return changed ? zipSync(files) : bytes;
}
