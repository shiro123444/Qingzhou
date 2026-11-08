const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const MAX_ATLAS_SIZE = 2048;
const MAX_PLANES = 9;
const MAX_NODES = 1600;
const GUTTER = 2;
const OUTPUT_SELECTOR =
  '[data-qz-glass-canvas], [data-qz-glass-definitions], [data-qz-glass-snapshot]';
const SKIP_TAGS = new Set([
  'audio',
  'base',
  'embed',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
  'source',
  'style',
  'template',
  'track',
  'video',
]);
// Copy computed presentation, never classes, stylesheets, event handlers, or arbitrary attributes.
const STYLE_PROPERTIES = [
  'align-content',
  'align-items',
  'align-self',
  'appearance',
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  'bottom',
  'box-shadow',
  'box-sizing',
  'color',
  'column-gap',
  'direction',
  'display',
  'fill',
  'fill-opacity',
  'flex',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'float',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'grid-template-columns',
  'grid-template-rows',
  'height',
  'justify-content',
  'justify-items',
  'justify-self',
  'left',
  'letter-spacing',
  'line-height',
  'list-style-position',
  'list-style-type',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'object-fit',
  'object-position',
  'opacity',
  'order',
  'overflow',
  'overflow-wrap',
  'overflow-x',
  'overflow-y',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'row-gap',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-width',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-overflow',
  'text-shadow',
  'text-transform',
  'top',
  'transform',
  'transform-origin',
  'vertical-align',
  'visibility',
  'white-space',
  'width',
  'word-break',
  'word-spacing',
  'writing-mode',
  'z-index',
];
const SVG_ATTRIBUTES = new Set([
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'fill-rule',
  'height',
  'lengthAdjust',
  'opacity',
  'pathLength',
  'points',
  'preserveAspectRatio',
  'r',
  'rx',
  'ry',
  'text-anchor',
  'textLength',
  'transform',
  'viewBox',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);
const SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
]);
const HTML_TAGS = new Set([
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'button',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'optgroup',
  'option',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  's',
  'samp',
  'section',
  'select',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

export interface GlassSourceBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GlassSourcePlane {
  bounds: GlassSourceBounds;
  id: string;
  /** Normalized atlas coordinates, with the origin at the canvas's top-left. */
  uvRect: [number, number, number, number];
}

export interface GlassSourceCapture {
  canvas: HTMLCanvasElement;
  dispose: () => void;
  planes: GlassSourcePlane[];
}

export interface CaptureGlassSourcesOptions {
  height: number;
  layers: Array<{ element: HTMLElement; id: string }>;
  root: HTMLElement;
  signal?: AbortSignal;
  width: number;
}

interface SnapshotBudget {
  nodes: number;
}

interface SnapshotOptions {
  bounds: GlassSourceBounds;
  budget?: SnapshotBudget;
  exclude?: ReadonlySet<Element>;
  foreground?: boolean;
  signal?: AbortSignal;
}

const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Glass source capture aborted.', 'AbortError');
};

/** No fetch is performed. Only already decoded, origin-readable image pixels may be copied. */
export function isLocalGlassResource(source: string, baseURI: string) {
  try {
    const url = new URL(source, baseURI);
    if (url.protocol === 'data:') return /^data:image\/(?:png|jpe?g|webp|gif|avif);/i.test(source);
    const base = new URL(baseURI);
    return (
      url.origin === base.origin &&
      (url.protocol === 'blob:' || url.protocol === 'http:' || url.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function inlineLoadedImage(source: Element) {
  const document = source.ownerDocument;
  const view = document.defaultView;
  if (!view) return;
  const canvas = document.createElement('canvas');
  let drawable: CanvasImageSource;
  let width: number;
  let height: number;
  if (source instanceof view.HTMLImageElement) {
    if (
      !source.complete ||
      !source.naturalWidth ||
      !isLocalGlassResource(source.currentSrc || source.src, document.baseURI)
    )
      return;
    drawable = source;
    width = source.naturalWidth;
    height = source.naturalHeight;
  } else if (source instanceof view.HTMLCanvasElement) {
    drawable = source;
    width = source.width;
    height = source.height;
  } else return;
  if (!width || !height) return;
  const scale = Math.min(1, 1024 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    // A tainted canvas or unreadable image remains a transparent source, never a proxy request.
    return;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function copyPresentation(source: Element, clone: HTMLElement | SVGElement, material: boolean) {
  const style = source.ownerDocument.defaultView!.getComputedStyle(source);
  for (const property of STYLE_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (!value || /url\s*\(|image-set\s*\(|paint\s*\(|image\s*\(/i.test(value)) continue;
    clone.style.setProperty(property, value);
  }
  // SVG image documents do not inherit page @font-face declarations. Use deterministic local fonts.
  clone.style.fontFamily = /mono/i.test(style.fontFamily)
    ? 'ui-monospace, monospace'
    : 'system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';
  clone.style.setProperty('animation', 'none');
  clone.style.setProperty('transition', 'none');
  clone.style.setProperty('filter', 'none');
  clone.style.setProperty('backdrop-filter', 'none');
  if (material) {
    clone.style.background = 'transparent';
    clone.style.borderColor = 'transparent';
    clone.style.boxShadow = 'none';
  }
  return style;
}

/** The scene wallpaper is a separate opaque plane behind every glass volume. */
export function serializeGlassWallpaper(source: HTMLElement, bounds: GlassSourceBounds) {
  const document = source.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error('Glass source has no window.');
  const style = view.getComputedStyle(source);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(bounds.width));
  svg.setAttribute('height', String(bounds.height));
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  const foreign = document.createElementNS(SVG_NS, 'foreignObject');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  const backdrop = document.createElementNS(XHTML_NS, 'div');
  const dark = style.colorScheme.trim() === 'dark';
  backdrop.style.cssText = `position:relative;width:${bounds.width}px;height:${bounds.height}px;overflow:hidden;background:${dark ? '#101315' : '#f4f7f8'};`;
  const paint = document.createElementNS(XHTML_NS, 'div');
  const rect = source.getBoundingClientRect();
  paint.style.cssText = `position:absolute;left:${rect.left - bounds.x}px;top:${rect.top - bounds.y}px;width:${rect.width || bounds.width}px;height:${rect.height || bounds.height}px;`;
  // Qingzhou's theme gradients belong to the scene host itself, not its optical pseudos.
  for (const property of [
    'background-color',
    'background-image',
    'background-position',
    'background-repeat',
    'background-size',
  ]) {
    const value = style.getPropertyValue(property);
    if (value && !/url\s*\(|image-set\s*\(|paint\s*\(|image\s*\(/i.test(value)) {
      paint.style.setProperty(property, value);
    }
  }
  backdrop.append(paint);
  foreign.append(backdrop);
  svg.append(foreign);
  return new XMLSerializer().serializeToString(svg);
}

/** Build a self-contained, resource-free SVG without attaching clones or changing live DOM. */
export async function serializeGlassSource(source: HTMLElement, options: SnapshotOptions) {
  const { bounds, exclude = new Set<Element>(), foreground = false, signal } = options;
  const budget = options.budget ?? { nodes: 0 };
  const document = source.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error('Glass source has no window.');
  checkAbort(signal);

  const cloneNode = async (node: Node): Promise<Node | null> => {
    checkAbort(signal);
    if (++budget.nodes > MAX_NODES)
      throw new RangeError('Glass source exceeds the capture node budget.');
    if (budget.nodes % 64 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkAbort(signal);
    }
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');
    if (!(node instanceof view.Element)) return null;
    const tag = node.localName;
    if (SKIP_TAGS.has(tag) || node.matches(OUTPUT_SELECTOR)) return null;
    const isSVG = node.namespaceURI === SVG_NS;
    if (isSVG && !SVG_TAGS.has(tag)) return null;
    const image = tag === 'img' || tag === 'canvas';
    // Recreating a registered custom element could run its constructor while detached.
    const safeTag = image ? 'img' : isSVG || HTML_TAGS.has(tag) ? tag : 'div';
    const clone = document.createElementNS(isSVG ? SVG_NS : XHTML_NS, safeTag) as
      HTMLElement | SVGElement;
    const material = node.hasAttribute('data-qz-glass') || (node === source && foreground);
    const style = copyPresentation(node, clone, material);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    if (exclude.has(node) && node !== source) {
      clone.style.visibility = 'hidden';
      clone.setAttribute('data-qz-source-placeholder', '');
      return clone;
    }
    if (isSVG) {
      for (const attribute of node.attributes) {
        if (SVG_ATTRIBUTES.has(attribute.name) && !/url\s*\(/i.test(attribute.value)) {
          clone.setAttribute(attribute.name, attribute.value);
        }
      }
    } else {
      for (const name of ['colspan', 'rowspan', 'span', 'open']) {
        if (node.hasAttribute(name)) clone.setAttribute(name, node.getAttribute(name)!);
      }
    }
    if (image) {
      const data = inlineLoadedImage(node);
      if (data) clone.setAttribute('src', data);
      else clone.style.visibility = 'hidden';
      return clone;
    }
    if (node instanceof view.HTMLInputElement) {
      clone.setAttribute('type', node.type === 'password' ? 'text' : node.type);
      clone.setAttribute(
        'value',
        node.type === 'password' ? '•'.repeat(node.value.length) : node.value,
      );
      if (node.checked) clone.setAttribute('checked', '');
    } else if (node instanceof view.HTMLTextAreaElement) {
      clone.textContent = node.value;
      return clone;
    }
    for (const child of node.childNodes) {
      const copy = await cloneNode(child);
      if (copy) clone.append(copy);
    }
    if (node instanceof view.HTMLElement && (node.scrollLeft || node.scrollTop)) {
      const scrolled = document.createElementNS(XHTML_NS, 'div');
      const pixels = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
      const width = node.clientWidth - pixels('padding-left') - pixels('padding-right');
      const height = node.clientHeight - pixels('padding-top') - pixels('padding-bottom');
      scrolled.style.cssText = `position:relative;transform:translate(${-node.scrollLeft}px,${-node.scrollTop}px);width:${Math.max(0, width)}px;height:${Math.max(0, height)}px;`;
      // The translated viewport must retain the original flex/grid formatting context.
      // A plain block wrapper would otherwise turn a scrolled toolbar/list into different rows.
      for (const property of [
        'display',
        'flex-direction',
        'flex-wrap',
        'align-items',
        'align-content',
        'justify-content',
        'justify-items',
        'gap',
        'row-gap',
        'column-gap',
        'grid-template-columns',
        'grid-template-rows',
        'grid-auto-flow',
      ]) {
        scrolled.style.setProperty(property, style.getPropertyValue(property));
      }
      while (clone.firstChild) scrolled.append(clone.firstChild);
      clone.append(scrolled);
      clone.style.display = style.display.startsWith('inline') ? 'inline-block' : 'block';
      clone.style.overflow = 'hidden';
    }
    return clone;
  };

  const clone = (await cloneNode(source)) as HTMLElement | null;
  if (!clone) throw new Error('Glass source is not visible.');
  const rect = source.getBoundingClientRect();
  clone.style.position = 'absolute';
  clone.style.left = `${rect.left - bounds.x}px`;
  clone.style.top = `${rect.top - bounds.y}px`;
  clone.style.margin = '0';
  clone.style.width = `${rect.width || bounds.width}px`;
  clone.style.height = `${rect.height || bounds.height}px`;
  clone.style.transform = 'none';
  clone.style.boxSizing = 'border-box';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(bounds.width));
  svg.setAttribute('height', String(bounds.height));
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  const foreign = document.createElementNS(SVG_NS, 'foreignObject');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  const viewport = document.createElementNS(XHTML_NS, 'div');
  viewport.style.cssText = `position:relative;overflow:hidden;width:${bounds.width}px;height:${bounds.height}px;`;
  viewport.append(clone);
  foreign.append(viewport);
  svg.append(foreign);
  return new XMLSerializer().serializeToString(svg);
}

/** Shelf packing keeps every texture within one bounded atlas, with filtering gutters. */
export function planGlassAtlas(bounds: ReadonlyArray<Pick<GlassSourceBounds, 'height' | 'width'>>) {
  if (!bounds.length || bounds.length > MAX_PLANES)
    throw new RangeError('Invalid glass plane count.');
  if (
    bounds.some(
      (item) =>
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        !Number.isFinite(item.height) ||
        item.height <= 0,
    )
  )
    throw new RangeError('Invalid glass source size.');
  let scale = Math.min(
    1,
    (MAX_ATLAS_SIZE - GUTTER * 2) /
      Math.max(...bounds.flatMap((item) => [item.width, item.height])),
  );
  for (;;) {
    let x = GUTTER;
    let y = GUTTER;
    let rowHeight = 0;
    let usedWidth = 0;
    const tiles = bounds.map((item) => {
      const width = Math.max(1, Math.round(item.width * scale));
      const height = Math.max(1, Math.round(item.height * scale));
      if (x + width + GUTTER > MAX_ATLAS_SIZE) {
        x = GUTTER;
        y += rowHeight + GUTTER * 2;
        rowHeight = 0;
      }
      const tile = { height, width, x, y };
      x += width + GUTTER * 2;
      rowHeight = Math.max(rowHeight, height);
      usedWidth = Math.max(usedWidth, x - GUTTER);
      return tile;
    });
    const height = y + rowHeight + GUTTER;
    if (height <= MAX_ATLAS_SIZE)
      return { height, tiles, width: Math.min(MAX_ATLAS_SIZE, usedWidth + GUTTER) };
    scale *= 0.8;
  }
}

function rasterize(svg: string, document: Document, signal?: AbortSignal) {
  checkAbort(signal);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = document.createElement('img');
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      image.onload = null;
      image.onerror = null;
    };
    const fail = (error: Error) => {
      cleanup();
      image.removeAttribute('src');
      reject(error);
    };
    const abort = () => fail(new DOMException('Glass source capture aborted.', 'AbortError'));
    const timer = setTimeout(() => fail(new Error('Glass source rasterization timed out.')), 3000);
    signal?.addEventListener('abort', abort, { once: true });
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => fail(new Error('Glass source rasterization failed.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export async function captureGlassSources({
  height,
  layers,
  root,
  signal,
  width,
}: CaptureGlassSourcesOptions): Promise<GlassSourceCapture> {
  checkAbort(signal);
  const eligible = layers.filter(({ element }) => element.dataset.qzGlass !== 'shell');
  const ids = new Set(['background', 'wallpaper']);
  const elements = new Set<Element>();
  const sources = [
    { bounds: { height, width, x: 0, y: 0 }, element: root, id: 'background' },
    { bounds: { height, width, x: 0, y: 0 }, element: root, id: 'wallpaper' },
  ];
  for (const layer of eligible) {
    if (ids.has(layer.id) || elements.has(layer.element))
      throw new Error('Duplicate glass source.');
    ids.add(layer.id);
    elements.add(layer.element);
    const rect = layer.element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < width &&
      rect.top < height
    ) {
      sources.push({
        ...layer,
        bounds: { height: rect.height, width: rect.width, x: rect.left, y: rect.top },
      });
    }
  }
  const atlas = planGlassAtlas(sources.map(({ bounds }) => bounds));
  const canvas = root.ownerDocument.createElement('canvas');
  canvas.width = atlas.width;
  canvas.height = atlas.height;
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error('Canvas 2D is unavailable for glass sources.');
  }
  const budget = { nodes: 0 };
  const planes: GlassSourcePlane[] = [];
  const dispose = () => {
    canvas.width = 0;
    canvas.height = 0;
  };
  try {
    for (const [index, source] of sources.entries()) {
      const svg =
        source.id === 'wallpaper'
          ? serializeGlassWallpaper(source.element, source.bounds)
          : await serializeGlassSource(source.element, {
              bounds: source.bounds,
              budget,
              exclude: elements,
              // The main page is transparent content at z=8; theme paint lives behind the shell.
              foreground: true,
              signal,
            });
      const image = await rasterize(svg, root.ownerDocument, signal);
      checkAbort(signal);
      const tile = atlas.tiles[index];
      context.drawImage(image, tile.x, tile.y, tile.width, tile.height);
      image.removeAttribute('src');
      planes.push({
        bounds: source.bounds,
        id: source.id,
        uvRect: [
          tile.x / canvas.width,
          tile.y / canvas.height,
          tile.width / canvas.width,
          tile.height / canvas.height,
        ],
      });
    }
    return { canvas, dispose, planes };
  } catch (error) {
    dispose();
    throw error;
  }
}
