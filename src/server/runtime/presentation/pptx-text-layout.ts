import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';

const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** SVG has already positioned its lines. Office must not reflow them during import. */
export function preserveSvgTextLayout(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes);
  let changed = false;
  for (const name of Object.keys(files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/u.test(name)) continue;
    const document = parseString(strFromU8(files[name]));
    let slideChanged = false;
    for (const body of Array.from(document.getElementsByTagNameNS(DRAWING, 'bodyPr'))) {
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
