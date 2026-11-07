import { generateGlassMaps } from './optics';
import { styles } from './style';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CACHE_LIMIT = 24;
const TARGET_SELECTOR = [
  '[data-qz-glass]',
  '[role="menu"][data-side]',
  '[role="dialog"][data-side]',
  '[role="dialog"][aria-modal="true"][data-open]:not([data-side]) > div:only-child',
  '.ant-modal-container',
  '.ant-popover-inner',
  '.ant-dropdown-menu',
  '.ant-drawer-content',
].join(',');

interface EncodedMaps {
  displacement: string;
  highlight: string;
  ready: Promise<boolean>;
  scale: number;
}

interface GlassMaterial {
  blur: number;
  thickness: number;
}

const MATERIALS: Record<string, GlassMaterial> = {
  capsule: { blur: 3, thickness: 12 },
  composer: { blur: 3, thickness: 10 },
  control: { blur: 0.5, thickness: 6 },
  editor: { blur: 8, thickness: 10 },
  header: { blur: 2, thickness: 8 },
  panel: { blur: 5, thickness: 10 },
  shell: { blur: 1.2, thickness: 8 },
  sidebar: { blur: 1.2, thickness: 8 },
};

interface GlassTarget {
  active: boolean;
  attributeObserver: MutationObserver;
  attributes: string;
  element: HTMLElement;
  filter: SVGFilterElement;
  id: string;
  material: GlassMaterial;
  mode: 'backplate' | 'direct';
  originalAttribute: string | null;
  originalFilter: string;
  originalFilterPriority: string;
  signature: string;
}

let clientCount = 0;
let stopRuntime: (() => void) | undefined;
let generation = 0;

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, number | string> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function supportsRefraction() {
  // WebKit accepts the CSS syntax but does not composite SVG URL backdrop filters.
  const userAgent = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return (
    !isIOS &&
    /(?:Chrome|Chromium|Edg)\//.test(userAgent) &&
    typeof ResizeObserver !== 'undefined' &&
    typeof MutationObserver !== 'undefined' &&
    CSS.supports('backdrop-filter', 'url("#qz-glass-support")')
  );
}

function encodeMaps(
  width: number,
  height: number,
  radius: number,
  thickness: number,
): EncodedMaps | undefined {
  const maps = generateGlassMaps({ height, radius, thickness, width });
  const canvas = document.createElement('canvas');
  canvas.width = maps.width;
  canvas.height = maps.height;
  const context = canvas.getContext('2d');
  if (!context) return;

  const encode = (pixels: Uint8ClampedArray) => {
    const image = context.createImageData(maps.width, maps.height);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  };

  const displacement = encode(maps.displacement);
  const highlight = encode(maps.highlight);
  const preload = (source: string) => {
    const image = new Image();
    image.src = source;
    return image.decode();
  };

  return {
    displacement,
    highlight,
    ready: Promise.all([preload(displacement), preload(highlight)]).then(
      () => true,
      () => false,
    ),
    scale: maps.scale,
  };
}

function buildFilter(
  filter: SVGFilterElement,
  maps: EncodedMaps,
  width: number,
  height: number,
  blur: number,
) {
  filter.setAttribute('width', String(width));
  filter.setAttribute('height', String(height));

  const displacementImage = svgElement('feImage', {
    height,
    href: maps.displacement,
    preserveAspectRatio: 'none',
    result: 'displacementTexture',
    width,
    x: 0,
    y: 0,
  });
  const neutralMap = svgElement('feComponentTransfer', {
    in: 'displacementTexture',
    result: 'displacement',
  });
  for (const channel of ['feFuncR', 'feFuncG'] as const) {
    neutralMap.append(
      svgElement(channel, { intercept: -1 / 254, slope: 255 / 254, type: 'linear' }),
    );
  }
  const refraction = svgElement('feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'displacement',
    result: 'refracted',
    scale: maps.scale,
    xChannelSelector: 'R',
    yChannelSelector: 'G',
  });
  const softness = svgElement('feGaussianBlur', {
    in: 'refracted',
    result: 'softened',
    stdDeviation: blur,
  });
  const highlight = svgElement('feImage', {
    height,
    href: maps.highlight,
    preserveAspectRatio: 'none',
    result: 'highlight',
    width,
    x: 0,
    y: 0,
  });
  const lighting = svgElement('feBlend', { in: 'softened', in2: 'highlight', mode: 'screen' });
  filter.replaceChildren(displacementImage, neutralMap, refraction, softness, highlight, lighting);
}

function attributesWithoutRuntime(element: HTMLElement) {
  const className = [...element.classList].filter((name) => name !== styles.optics).join(' ');
  const style = element.style.cssText
    .replaceAll(/--qz-refraction-filter\s*:[^;]*(?:;|$)/g, '')
    .trim();
  return `${className}|${style}|${element.dataset.qzGlass ?? ''}`;
}

function uniformRadius(corners: string[], width: number, height: number) {
  const radii = corners.map((value) => {
    const [horizontal, vertical = horizontal] = value.split(/\s+/);
    const resolve = (length: string, extent: number) =>
      Number.parseFloat(length) * (length.endsWith('%') ? extent / 100 : 1);
    return [resolve(horizontal, width), resolve(vertical, height)];
  });
  const radius = radii[0][0];
  // The optical model supports one circular radius, not asymmetric or elliptical corners.
  if (
    radii.some((corner) =>
      corner.some((value) => !Number.isFinite(value) || Math.abs(value - radius) > 0.01),
    )
  )
    return;
  return Math.min(width / 2, height / 2, radius);
}

function createRegistry() {
  const targets = new Map<HTMLElement, GlassTarget>();
  const cache = new Map<string, EncodedMaps>();
  const pending = new Set<GlassTarget>();
  const prefix = `qz-glass-${Date.now().toString(36)}-${++generation}`;
  let nextId = 0;
  let frame = 0;

  const root = svgElement('svg', {
    'aria-hidden': 'true',
    'focusable': 'false',
    'height': 0,
    'width': 0,
  });
  root.classList.add(styles.definitions);
  root.dataset.qzGlassDefinitions = '';
  const definitions = svgElement('defs');
  root.append(definitions);
  document.body.append(root);

  const clearOptics = (target: GlassTarget) => {
    const { element } = target;
    target.active = false;
    target.filter.replaceChildren();
    element.classList.remove(styles.optics);
    if (target.originalAttribute === null) element.removeAttribute('data-qz-optics');
    else element.setAttribute('data-qz-optics', target.originalAttribute);
    if (target.originalFilter) {
      element.style.setProperty(
        '--qz-refraction-filter',
        target.originalFilter,
        target.originalFilterPriority,
      );
    } else {
      element.style.removeProperty('--qz-refraction-filter');
    }
  };

  const applyOptics = (target: GlassTarget) => {
    const { element } = target;
    element.style.setProperty('--qz-refraction-filter', `url("#${target.id}")`);
    element.dataset.qzOptics = target.mode;
    element.classList.add(styles.optics);
  };

  const update = async (target: GlassTarget) => {
    const { element } = target;
    if (!element.isConnected) return;
    const kind = element.dataset.qzGlass;
    target.material = MATERIALS[kind ?? 'panel'] ?? MATERIALS.panel;
    target.mode = kind === 'shell' || kind === 'sidebar' ? 'backplate' : 'direct';
    // Layout dimensions stay stable during popup transforms and capsule dragging.
    const width = target.mode === 'backplate' ? element.clientWidth : element.offsetWidth;
    const height = target.mode === 'backplate' ? element.clientHeight : element.offsetHeight;
    const computed = getComputedStyle(element);
    const corners = [
      computed.borderTopLeftRadius,
      computed.borderTopRightRadius,
      computed.borderBottomRightRadius,
      computed.borderBottomLeftRadius,
    ];
    const signature = `${target.mode}:${width}:${height}:${corners.join(':')}:${target.material.thickness}:${target.material.blur}`;
    if (target.signature === signature) {
      if (target.active) applyOptics(target);
      return;
    }
    target.signature = signature;
    clearOptics(target);
    if (!width || !height) return;
    const radius = uniformRadius(corners, width, height);
    // Preserve the CSS frosted material when the model cannot match the actual outline.
    if (radius === undefined) return;
    const key = `${width}:${height}:${radius}:${target.material.thickness}`;
    let maps = cache.get(key);
    if (maps) {
      cache.delete(key);
      cache.set(key, maps);
    } else {
      maps = encodeMaps(width, height, radius, target.material.thickness);
      if (!maps) return;
      cache.set(key, maps);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    }

    const ready = await maps.ready;
    if (
      !ready ||
      !element.isConnected ||
      targets.get(element) !== target ||
      target.signature !== signature
    )
      return;

    buildFilter(target.filter, maps, width, height, target.material.blur);
    target.active = true;
    applyOptics(target);
  };

  const schedule = (target: GlassTarget) => {
    pending.add(target);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const item of pending) void update(item);
      pending.clear();
    });
  };

  const resizeObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const registered = targets.get(target as HTMLElement);
      if (registered) schedule(registered);
    }
  });

  const register = (element: Element) => {
    if (!(element instanceof HTMLElement) || targets.has(element)) return;
    const id = `${prefix}-${++nextId}`;
    const filter = svgElement('filter', {
      'color-interpolation-filters': 'sRGB',
      'filterUnits': 'userSpaceOnUse',
      id,
      'primitiveUnits': 'userSpaceOnUse',
      'x': 0,
      'y': 0,
    });
    definitions.append(filter);
    const kind = element.dataset.qzGlass;
    const attributeObserver = new MutationObserver(() => {
      const target = targets.get(element);
      if (!target) return;
      if (!element.matches(TARGET_SELECTOR)) {
        unregister(target);
        return;
      }
      const attributes = attributesWithoutRuntime(element);
      const lostRuntimeStyle =
        target.active &&
        (!element.classList.contains(styles.optics) ||
          !element.style.getPropertyValue('--qz-refraction-filter'));
      if (attributes === target.attributes && !lostRuntimeStyle) return;
      target.attributes = attributes;
      schedule(target);
    });
    const target: GlassTarget = {
      active: false,
      attributeObserver,
      attributes: attributesWithoutRuntime(element),
      element,
      filter,
      id,
      material: MATERIALS[kind ?? 'panel'] ?? MATERIALS.panel,
      mode: kind === 'shell' || kind === 'sidebar' ? 'backplate' : 'direct',
      originalAttribute: element.getAttribute('data-qz-optics'),
      originalFilter: element.style.getPropertyValue('--qz-refraction-filter'),
      originalFilterPriority: element.style.getPropertyPriority('--qz-refraction-filter'),
      signature: '',
    };
    targets.set(element, target);
    attributeObserver.observe(element, {
      attributeFilter: ['class', 'style', 'data-qz-glass'],
      attributes: true,
    });
    resizeObserver.observe(element);
    schedule(target);
  };

  const unregister = (target: GlassTarget) => {
    const { element } = target;
    target.attributeObserver.disconnect();
    resizeObserver.unobserve(element);
    pending.delete(target);
    clearOptics(target);
    target.filter.remove();
    targets.delete(element);
  };

  const scan = (element: Element) => {
    if (element === root || root.contains(element)) return;
    if (element.matches(TARGET_SELECTOR)) register(element);
    for (const child of element.querySelectorAll(TARGET_SELECTOR)) register(child);
  };

  const mutations = new MutationObserver((records) => {
    let removedElements = false;
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) scan(node);
      for (const node of record.removedNodes) {
        if (node instanceof Element && !root.contains(record.target)) removedElements = true;
      }
    }
    if (removedElements) {
      for (const target of targets.values()) if (!target.element.isConnected) unregister(target);
    }
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  scan(document.body);

  return () => {
    mutations.disconnect();
    resizeObserver.disconnect();
    cancelAnimationFrame(frame);
    for (const target of targets.values()) unregister(target);
    pending.clear();
    cache.clear();
    root.remove();
  };
}

function startRuntime() {
  if (!supportsRefraction()) return () => {};
  const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const highContrast = matchMedia('(prefers-contrast: more)');
  let stopRegistry: (() => void) | undefined;

  const syncPreference = () => {
    if (reduceTransparency.matches || highContrast.matches) {
      stopRegistry?.();
      stopRegistry = undefined;
    } else if (!stopRegistry) stopRegistry = createRegistry();
  };
  reduceTransparency.addEventListener('change', syncPreference);
  highContrast.addEventListener('change', syncPreference);
  syncPreference();

  return () => {
    reduceTransparency.removeEventListener('change', syncPreference);
    highContrast.removeEventListener('change', syncPreference);
    stopRegistry?.();
  };
}

/** Reference counting keeps StrictMode and nested preview providers from duplicating observers. */
export function mountLiquidGlass() {
  clientCount += 1;
  if (clientCount === 1) stopRuntime = startRuntime();
  let mounted = true;

  return () => {
    if (!mounted) return;
    mounted = false;
    clientCount -= 1;
    if (clientCount === 0) {
      stopRuntime?.();
      stopRuntime = undefined;
    }
  };
}
