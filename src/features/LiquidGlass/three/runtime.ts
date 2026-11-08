import { watchGlassPreferences } from '../preferences';
import { styles as fallbackStyles } from '../style';
import { type Vec3 } from './geometry';
import { captureDelay, GlassFrameBudget } from './performance';
import { type GlassVolume } from './raytrace';
import { createGlassRenderer, type GlassRenderer, type GlassRenderPlane } from './renderer';
import { resolveSceneDepths } from './scene';
import { captureGlassSources } from './sources';
import { styles } from './style';

const SELECTOR = [
  '[data-qz-glass]',
  '[role="menu"][data-side]',
  '[role="dialog"][data-side]',
  '[role="dialog"][aria-modal="true"][data-open]:not([data-side]) > div:only-child',
  '.ant-modal-container',
  '.ant-popover-inner',
  '.ant-dropdown-menu',
  '.ant-drawer-content',
].join(',');
const OUTPUT = '[data-qz-glass-canvas], [data-qz-glass-definitions]';
const MAX_SURFACES = 8;

interface Material {
  front: number;
  priority: number;
  thickness: number;
}

const materials: Record<string, Material> = {
  shell: { front: 4, priority: 10, thickness: 2 },
  sidebar: { front: 16, priority: 40, thickness: 6 },
  header: { front: 16, priority: 35, thickness: 6 },
  composer: { front: 28, priority: 80, thickness: 8 },
  control: { front: 28, priority: 50, thickness: 6 },
  capsule: { front: 48, priority: 100, thickness: 12 },
  panel: { front: 72, priority: 90, thickness: 10 },
  editor: { front: 96, priority: 85, thickness: 10 },
};

interface Target {
  canvas: HTMLCanvasElement;
  element: HTMLElement;
  gpuSamples?: number;
  id: string;
  originalPosition: string;
  positioned: boolean;
  renderer?: GlassRenderer | null;
}

interface VisibleTarget {
  bounds: { height: number; width: number; x: number; y: number };
  front: number;
  kind: string;
  target: Target;
  volume: GlassVolume;
}

type SourceFrame = Awaited<ReturnType<typeof captureGlassSources>>;
let clients = 0;
let stop: (() => void) | undefined;
let generation = 0;

const cleanClass = (value: string) =>
  value
    .split(/\s+/)
    .filter((name) => name !== styles.surface && name !== fallbackStyles.optics)
    .join(' ');

function start() {
  const targets = new Map<HTMLElement, Target>();
  let preferencesAllowed = false;
  let renderer: GlassRenderer | null = null;
  let source: SourceFrame | undefined;
  let sourceVersion = 0;
  let stopped = false;
  let frame = 0;
  let timer = 0;
  let lastCapture = -Infinity;
  let capturePending = false;
  let sourceDirty = true;
  let sourceInvalid = false;
  let layoutEpoch = 0;
  let controller: AbortController | undefined;
  let serial = 0;
  let drawSignature = '';
  let sharedSignature = '';
  let sharedSourceVersion = -1;
  let captureDuration = 0;
  let allSourcesDirty = true;
  let dirtySources = new Set<string>();
  let interactionUntil = 0;
  const budget = new GlassFrameBudget();
  const staging = document.createElement('canvas');
  const stagingContext = staging.getContext('2d');
  const prefix = `qz-three-${++generation}`;

  const sceneRoot = () =>
    document.querySelector<HTMLElement>('[data-qz-glass-scene], .qz-glass-scene');
  const preferenceAllows = () => preferencesAllowed;

  const deactivate = (target: Target) => {
    target.canvas.remove();
    target.element.classList.remove(styles.surface);
    target.element.removeAttribute('data-qz-renderer');
    if (target.positioned) {
      target.element.style.position = target.originalPosition;
      target.positioned = false;
    }
  };
  const deactivateAll = () => {
    drawSignature = '';
    sharedSignature = '';
    targets.forEach(deactivate);
  };

  const makeRenderer = () =>
    createGlassRenderer({
      maxPixels: 100_000,
      onContextLost: () => {
        controller?.abort();
        deactivateAll();
      },
      onContextRestored: () => {
        renderer?.dispose();
        renderer = makeRenderer();
        invalidate(true);
      },
    });

  const visibleTargets = (): VisibleTarget[] => {
    const candidates: (VisibleTarget & { priority: number })[] = [];
    for (const target of targets.values()) {
      const { element } = target;
      if (!element.isConnected || element.dataset.qzGlassBackend === 'svg') continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width < 4 ||
        rect.height < 4 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= innerHeight ||
        rect.left >= innerWidth
      )
        continue;
      const computed = getComputedStyle(element);
      if (computed.visibility === 'hidden' || computed.display === 'none') continue;
      const corners = [
        computed.borderTopLeftRadius,
        computed.borderTopRightRadius,
        computed.borderBottomRightRadius,
        computed.borderBottomLeftRadius,
      ];
      const radii = corners.map((corner) => {
        const [x, y = x] = corner.split(/\s+/);
        const resolve = (value: string, size: number) =>
          parseFloat(value) * (value.endsWith('%') ? size / 100 : 1);
        return [resolve(x, rect.width), resolve(y, rect.height)];
      });
      const radius = radii[0][0];
      if (
        !Number.isFinite(radius) ||
        radii.some((corner) => corner.some((r) => Math.abs(r - radius) > 0.1))
      )
        continue;
      const kind = element.dataset.qzGlass ?? 'panel';
      const material = materials[kind] ?? materials.panel;
      const depth = Number(element.dataset.qzGlassDepth);
      const front = Number.isFinite(depth) && element.dataset.qzGlassDepth ? depth : material.front;
      const thickness = Math.min(material.thickness, rect.width / 3, rect.height / 3);
      candidates.push({
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        front,
        kind,
        priority: material.priority,
        target,
        volume: {
          id: target.id,
          center: [rect.x + rect.width / 2, rect.y + rect.height / 2, front - thickness / 2],
          size: [rect.width, rect.height, thickness],
          radius: Math.min(radius, rect.width / 2, rect.height / 2),
          bevel: Math.min(thickness / 2, 6, radius),
          ior: 1.45,
          absorption: [0.0015, 0.0005, 0.0007],
        },
      });
    }
    let foregroundCount = 0;
    const selected = candidates
      .sort((a, b) => b.priority - a.priority)
      .filter(({ kind }) => kind === 'shell' || ++foregroundCount <= 7)
      .slice(0, MAX_SURFACES);
    // DOM paint order decides which pane sits in front; material depths are only minima.
    selected.sort((a, b) => {
      if (a.target.element.contains(b.target.element)) return -1;
      if (b.target.element.contains(a.target.element)) return 1;
      const left = Math.max(a.bounds.x, b.bounds.x);
      const top = Math.max(a.bounds.y, b.bounds.y);
      const right = Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width);
      const bottom = Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height);
      if (left < right && top < bottom) {
        for (const element of document.elementsFromPoint((left + right) / 2, (top + bottom) / 2)) {
          if (a.target.element.contains(element)) return 1;
          if (b.target.element.contains(element)) return -1;
        }
      }
      return a.target.element.compareDocumentPosition(b.target.element) &
        Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
    return resolveSceneDepths(selected);
  };

  const themeEnvironment = (): { top: Vec3; bottom: Vec3 } => {
    const root = sceneRoot();
    const color = root ? getComputedStyle(root).color : '';
    const channels = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    const dark = channels
      ? channels.reduce((a, b) => a + b, 0) > 384
      : matchMedia('(prefers-color-scheme: dark)').matches;
    return dark
      ? { top: [0.48, 0.56, 0.57], bottom: [0.025, 0.035, 0.04] }
      : { top: [0.94, 0.98, 0.98], bottom: [0.84, 0.91, 0.92] };
  };

  const draw = (now: number) => {
    if (stopped || sourceInvalid || !preferenceAllows() || !source || !renderer) return;
    const visible = visibleTargets().filter(
      ({ kind, target }) => kind === 'shell' || source!.planes.some(({ id }) => id === target.id),
    );
    const selected = new Set(visible.map(({ target }) => target));
    for (const target of targets.values()) if (!selected.has(target)) deactivate(target);
    const planes: GlassRenderPlane[] = [];
    for (const plane of source.planes) {
      const owner = visible.find(({ target }) => target.id === plane.id);
      if (!owner && plane.id !== 'background' && plane.id !== 'wallpaper') continue;
      const bounds = owner?.bounds ?? plane.bounds;
      planes.push({
        id: `${plane.id}-content`,
        // Main-page text is the shell's own native foreground. Other panes may see it,
        // but the shell must not mirror it back underneath the same text.
        ownerVolumeId:
          owner?.target.id ??
          (plane.id === 'background'
            ? visible.find(({ kind }) => kind === 'shell')?.target.id
            : undefined),
        center: [
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
          owner ? owner.front + 0.1 : plane.id === 'wallpaper' ? 0 : 8,
        ],
        size: [bounds.width, bounds.height],
        uvRect: plane.uvRect,
        opaque: plane.id === 'wallpaper',
      });
    }
    const environment = themeEnvironment();
    const signature = JSON.stringify([
      sourceVersion,
      environment,
      visible.map(({ volume }) => volume),
    ]);
    const geometryChanged = signature !== drawSignature;
    if (!geometryChanged && signature === sharedSignature) return;
    drawSignature = signature;
    const volumes = visible.map(({ volume }) => volume);
    const request = (item: VisibleTarget) => ({
      activeVolumeId: item.target.id,
      target: item.bounds,
      volumes,
      planes,
      source: source!.canvas,
      sourceBlur: item.kind === 'capsule' ? 5 : item.kind === 'shell' ? 0 : 3,
      sourceVersion,
      viewport: { width: innerWidth, height: innerHeight },
      pixelRatio: Math.min(
        devicePixelRatio,
        1.5,
        Math.sqrt(
          (item.kind === 'capsule' ? budget.capsulePixels() : budget.sharedPixels()) /
            (item.bounds.width * item.bounds.height),
        ),
      ),
      environmentTop: environment.top,
      environmentBottom: environment.bottom,
    });
    const attach = ({ target }: VisibleTarget) => {
      const { canvas, element } = target;
      if (getComputedStyle(element).position === 'static') {
        target.positioned = true;
        element.style.position = 'relative';
      }
      if (canvas.parentElement !== element) element.prepend(canvas);
      if (!element.classList.contains(styles.surface)) element.classList.add(styles.surface);
      if (element.dataset.qzRenderer !== 'webgl2') element.dataset.qzRenderer = 'webgl2';
    };
    // The player has a visible GPU canvas: moving it never requires a synchronous GPU→CPU copy.
    if (geometryChanged)
      for (const item of visible.filter(({ kind }) => kind === 'capsule')) {
        const { target } = item;
        if (target.renderer === undefined)
          target.renderer = createGlassRenderer({
            canvas: target.canvas,
            preserveDrawingBuffer: false,
            maxPixels: 100_000,
            onContextLost: () => deactivate(target),
            onContextRestored: () => {
              target.renderer?.dispose();
              target.renderer = undefined;
              target.canvas = makeCanvas();
              drawSignature = '';
              requestDraw();
            },
          });
        if (!target.renderer?.render(request(item))) {
          deactivate(target);
          continue;
        }
        const metrics = target.renderer.metrics;
        if (metrics.gpuSamples !== target.gpuSamples && metrics.gpuMilliseconds !== undefined) {
          budget.recordCapsule(metrics.gpuMilliseconds);
          target.gpuSamples = metrics.gpuSamples;
        }
        attach(item);
      }
    const secondary = visible.filter(({ kind }) => kind !== 'capsule');
    if (!secondary.length || sharedSignature === signature || !stagingContext) return;
    const interacting = now < interactionUntil;
    if (!budget.shouldDrawShared(now, interacting, sharedSourceVersion !== sourceVersion)) {
      requestDraw();
      return;
    }
    const before = performance.now();
    const batch = renderer.renderBatch(secondary.map(request));
    if (!batch) {
      secondary.forEach(({ target }) => deactivate(target));
      return;
    }
    if (staging.width !== batch.canvas.width) staging.width = batch.canvas.width;
    if (staging.height !== batch.canvas.height) staging.height = batch.canvas.height;
    stagingContext.clearRect(0, 0, staging.width, staging.height);
    // Exactly one GPU read/copy for all secondary surfaces, then ordinary 2D tile copies.
    stagingContext.drawImage(batch.canvas, 0, 0);
    for (const tile of batch.tiles) {
      const item = secondary.find(({ target }) => target.id === tile.activeVolumeId)!;
      const { canvas } = item.target;
      if (canvas.width !== tile.width) canvas.width = tile.width;
      if (canvas.height !== tile.height) canvas.height = tile.height;
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        staging,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
        0,
        0,
        tile.width,
        tile.height,
      );
      attach(item);
    }
    budget.recordShared(
      now,
      Math.max(performance.now() - before, renderer.metrics.gpuMilliseconds ?? 0),
    );
    sharedSignature = signature;
    sharedSourceVersion = sourceVersion;
  };

  const capture = async () => {
    timer = 0;
    if (stopped || capturePending || !sourceDirty || !preferenceAllows() || !renderer) return;
    const root = sceneRoot();
    if (!root) return;
    root.dataset.qzGlassStatus = 'capturing';
    capturePending = true;
    sourceDirty = false;
    lastCapture = performance.now();
    const active = visibleTargets();
    const layers = active
      .filter(({ kind }) => kind !== 'shell')
      .slice(0, 7)
      .map(({ target }) => ({ id: target.id, element: target.element }));
    controller = new AbortController();
    const signal = controller.signal;
    const epoch = layoutEpoch;
    const dirty = allSourcesDirty ? undefined : dirtySources;
    allSourcesDirty = false;
    dirtySources = new Set();
    try {
      const next = await captureGlassSources({
        root,
        layers,
        width: innerWidth,
        height: innerHeight,
        signal,
        previous: source,
        dirtyIds: dirty,
      });
      if (stopped || signal.aborted || !preferenceAllows() || epoch !== layoutEpoch) {
        next.dispose();
        return;
      }
      source?.dispose();
      source = next;
      captureDuration = next.stats.durationMs;
      sourceVersion++;
      sourceInvalid = false;
      root.dataset.qzGlassStatus = 'ready';
      delete root.dataset.qzGlassError;
      requestDraw();
    } catch (error) {
      if (!signal.aborted) {
        sourceInvalid = true;
        allSourcesDirty = true;
        deactivateAll();
        root.dataset.qzGlassStatus = 'fallback';
        root.dataset.qzGlassError =
          error instanceof Error ? error.message : 'Source capture unavailable';
      }
      // Missing fonts/assets, an unsupported DOM source or GPU loss keep the live SVG material.
      if (!source) deactivateAll();
    } finally {
      capturePending = false;
      if (sourceDirty && !stopped) scheduleCapture();
    }
  };

  const scheduleCapture = () => {
    if (timer || capturePending || stopped || !preferenceAllows() || !renderer) return;
    timer = window.setTimeout(
      () => void capture(),
      captureDelay(performance.now() - lastCapture, captureDuration),
    );
  };
  const requestDraw = () => {
    if (frame || stopped) return;
    frame = requestAnimationFrame((now) => {
      frame = 0;
      draw(now);
    });
  };
  function invalidate(content: boolean, element?: Element) {
    if (content) {
      // Completed layers remain usable while the next revision is captured. Content changes
      // do not cancel unrelated work or remove the live player during typing/audio time updates.
      sourceDirty = true;
      if (
        !element ||
        element === sceneRoot() ||
        element === document.body ||
        element === document.documentElement
      ) {
        allSourcesDirty = true;
      } else {
        let owner: Target | undefined;
        for (const target of targets.values()) {
          if (
            target.element.dataset.qzGlass !== 'shell' &&
            target.element.contains(element) &&
            (!owner || owner.element.contains(target.element))
          )
            owner = target;
        }
        dirtySources.add(owner?.id ?? 'background');
        for (const target of targets.values())
          if (element.contains(target.element)) dirtySources.add(target.id);
      }
      scheduleCapture();
    }
    requestDraw();
  }

  const invalidateLayout = () => {
    layoutEpoch++;
    sourceInvalid = true;
    controller?.abort();
    deactivateAll();
    invalidate(true);
  };
  function makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.className = styles.canvas;
    canvas.dataset.qzGlassCanvas = '';
    canvas.setAttribute('aria-hidden', 'true');
    return canvas;
  }
  const resize = new ResizeObserver(invalidateLayout);
  const register = (element: Element) => {
    if (
      !(element instanceof HTMLElement) ||
      targets.has(element) ||
      element.dataset.qzGlassBackend === 'svg'
    )
      return;
    const canvas = makeCanvas();
    const target: Target = {
      element,
      canvas,
      id: `${prefix}-${++serial}`,
      originalPosition: element.style.position,
      positioned: false,
    };
    targets.set(element, target);
    resize.observe(element);
  };
  const scan = (element: Element) => {
    if (element.matches(OUTPUT) || element.closest(OUTPUT)) return;
    if (element.matches(SELECTOR)) register(element);
    element.querySelectorAll(SELECTOR).forEach(register);
  };
  const mutations = new MutationObserver((records) => {
    let content = false;
    let geometry = false;
    let structure = false;
    const beforeTargets = targets.size;
    const changed = new Set<Element>();
    for (const record of records) {
      const element =
        record.target instanceof Element ? record.target : record.target.parentElement;
      if (!element || element.closest(OUTPUT)) continue;
      if (record.type === 'attributes' && element.matches(SELECTOR)) register(element);
      if (record.type === 'childList') {
        for (const node of record.addedNodes) if (node instanceof Element) scan(node);
        const realNodes = [...record.addedNodes, ...record.removedNodes].some(
          (node) => !(node instanceof Element) || !node.matches(OUTPUT),
        );
        content ||= realNodes;
      } else if (record.type === 'characterData') content = true;
      else if (record.attributeName === 'class') {
        content ||=
          cleanClass(record.oldValue ?? '') !== cleanClass(element.getAttribute('class') ?? '');
      } else if (record.attributeName === 'style') {
        geometry = true;
        // Only our own position insertion and position-only drag changes may reuse content.
        const withoutPosition = (value: string) =>
          value
            .replaceAll(/(?:^|;)\s*(?:left|top|right|bottom|transform|position)\s*:[^;]*/gi, '')
            .replaceAll(/[;\s]/g, '');
        content ||=
          withoutPosition(record.oldValue ?? '') !==
            withoutPosition(element.getAttribute('style') ?? '') ||
          // Moving ordinary page content changes its optical texture. Only a registered
          // glass pane (or its explicit motion container) can reuse the same local pixels.
          (!targets.has(element as HTMLElement) && !element.hasAttribute('data-qz-glass-motion'));
      } else content = true;
      if (content) changed.add(element);
    }
    for (const target of targets.values()) {
      if (!target.element.isConnected || !target.element.matches(SELECTOR)) {
        resize.unobserve(target.element);
        deactivate(target);
        target.renderer?.dispose();
        targets.delete(target.element);
        content = true;
        structure = true;
      }
    }
    if (structure || targets.size !== beforeTargets) invalidateLayout();
    else if (content) changed.forEach((element) => invalidate(true, element));
    else if (geometry) invalidate(false);
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      'class',
      'style',
      'hidden',
      'src',
      'value',
      'data-qz-glass',
      'data-qz-glass-depth',
      'data-qz-glass-backend',
      'data-side',
      'data-open',
      'role',
    ],
  });
  scan(document.body);

  const scroll = invalidateLayout;
  const geometry = (event: PointerEvent) => {
    if (event.buttons) {
      interactionUntil = performance.now() + 100;
      invalidate(false);
    }
  };
  const content = (event: Event) => {
    if (event.type === 'input') interactionUntil = performance.now() + 100;
    invalidate(true, event.target instanceof Element ? event.target : undefined);
  };
  const pointerUp = () => {
    interactionUntil = 0;
    requestDraw();
  };
  const sync = () => {
    if (!preferenceAllows()) {
      controller?.abort();
      clearTimeout(timer);
      timer = 0;
      deactivateAll();
      renderer?.dispose();
      renderer = null;
      for (const target of targets.values()) {
        target.renderer?.dispose();
        target.renderer = undefined;
        target.canvas = makeCanvas();
      }
      source?.dispose();
      source = undefined;
    } else {
      renderer ??= makeRenderer();
      invalidate(true);
    }
  };
  document.addEventListener('scroll', scroll, true);
  document.addEventListener('pointermove', geometry, { passive: true });
  document.addEventListener('pointerup', pointerUp, { passive: true });
  document.addEventListener('input', content, true);
  document.addEventListener('load', content, true);

  window.addEventListener('resize', scroll);
  const unwatchPreferences = watchGlassPreferences((allowed) => {
    preferencesAllowed = allowed;
    sync();
  });

  return () => {
    stopped = true;
    controller?.abort();
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize.disconnect();
    document.removeEventListener('scroll', scroll, true);
    document.removeEventListener('pointermove', geometry);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('input', content, true);
    document.removeEventListener('load', content, true);
    unwatchPreferences();
    window.removeEventListener('resize', scroll);
    deactivateAll();
    targets.forEach((target) => target.renderer?.dispose());
    targets.clear();
    staging.width = 0;
    staging.height = 0;
    source?.dispose();
    renderer?.dispose();
  };
}

/** A direct player GPU canvas and a batched background renderer share one incremental source job. */
export function mountThreeGlass() {
  if (++clients === 1) stop = start();
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    if (--clients === 0) {
      stop?.();
      stop = undefined;
    }
  };
}
