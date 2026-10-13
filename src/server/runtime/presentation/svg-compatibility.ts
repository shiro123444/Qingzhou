import { XMLBuilder, XMLParser } from 'fast-xml-parser';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';

type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };
const options = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
};

/** Canonicalize attribute quotes and shape opacity for ppt-master's SVG tools. */
export const normalizePresentationSvg = (svg: string): string => {
  // Some ppt-master checks read attributes with double-quote-only patterns.
  // XML serialization preserves coordinates and escapes attribute contents safely.
  if (/<[\w:.-]+\b[^>]*\s[\w:.-]+\s*=\s*'/u.test(svg)) svg = parseString(svg).toString();
  if (!/<g\b[^>]*\sopacity\s*=/i.test(svg)) return svg;
  const nodes = new XMLParser(options).parse(svg) as XmlNode[];
  const opacity = (value?: string) =>
    value === undefined
      ? 1
      : Math.max(0, Math.min(1, Number.parseFloat(value) / (value.endsWith('%') ? 100 : 1)));
  const visit = (nodes: XmlNode[], inherited = 1): void => {
    for (const node of nodes) {
      const tag = Object.keys(node).find((key) => key !== ':@');
      if (!tag || tag.startsWith('#') || tag.startsWith('?')) continue;
      const attributes = node[':@'] ?? {};
      const combined = inherited * opacity(attributes['@_opacity']);
      if (!Number.isFinite(combined)) throw new Error('Invalid SVG opacity');
      if (tag === 'g') {
        delete attributes['@_opacity'];
        node[':@'] = attributes;
        if (Array.isArray(node[tag])) visit(node[tag] as XmlNode[], combined);
      } else {
        if (inherited !== 1) node[':@'] = { ...attributes, '@_opacity': String(combined) };
        if (Array.isArray(node[tag])) visit(node[tag] as XmlNode[]);
      }
    }
  };
  visit(nodes);
  return new XMLBuilder(options).build(nodes);
};

/** The PPT converter needs raster alpha baked into pixels, not an SVG image opacity attribute. */
export const normalizeRasterOpacity = async (
  svg: string,
  transform: (ref: string, opacity: number) => Promise<string>,
): Promise<string> => {
  if (!/<image\b[^>]*\sopacity\s*=/i.test(svg)) return svg;
  const nodes = new XMLParser(options).parse(svg) as XmlNode[];
  const visit = async (items: XmlNode[]): Promise<void> => {
    for (const node of items) {
      const tag = Object.keys(node).find((key) => key !== ':@');
      if (!tag) continue;
      const attrs = node[':@'];
      if (tag === 'image' && attrs?.['@_opacity'] !== undefined) {
        const value = attrs['@_opacity'];
        const opacity = Number.parseFloat(value) / (value.endsWith('%') ? 100 : 1);
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
          throw new Error('Invalid raster opacity');
        const href = attrs['@_href'] !== undefined ? '@_href' : '@_xlink:href';
        if (!attrs[href]) throw new Error('Raster opacity requires a source image');
        if (opacity !== 1) attrs[href] = await transform(attrs[href], opacity);
        delete attrs['@_opacity'];
      }
      if (Array.isArray(node[tag])) await visit(node[tag] as XmlNode[]);
    }
  };
  await visit(nodes);
  return new XMLBuilder(options).build(nodes);
};
