import { createStaticStyles, cssVar } from 'antd-style';
import type Konva from 'konva';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { glassSelection } from '@/features/GlassMotion/selectionStyle';

import type { CanvasObject } from '../../../packages/runtime-contracts/src/canvas';
import { selectionBounds, snapAxis } from './selection';
import {
  arrangePages,
  type Camera,
  type CanvasPage,
  fitCamera,
  type Point,
  zoomCamera,
} from './viewport';

export interface CanvasControls {
  fitAll: () => void;
  fitPage: () => void;
  zoomBy: (factor: number) => void;
  zoomTo: (scale: number) => void;
}

export type { CanvasObject } from '../../../packages/runtime-contracts/src/canvas';

interface CanvasSurfaceProps {
  boardId: string;
  children: ReactNode;
  currentPageId: string;
  fitPadding?: number;
  height: number;
  label: string;
  mode: 'select' | 'pan' | 'passive';
  objects: CanvasObject[];
  expandSelection?: (ids: string[]) => string[];
  onFocusPage?: () => void;
  onGroupShortcut?: (ungroup: boolean) => void;
  onResize?: (factor: number, ax: number, ay: number) => void;
  resizeLabel?: string;
  onClearDocumentSelection?: () => boolean;
  onDocumentTap?: (point: Point, edit: boolean) => boolean;
  onEditSelection?: () => boolean;
  onDragPreview?: (
    id?: string,
    dx?: number,
    dy?: number,
    factor?: number,
    ax?: number,
    ay?: number,
  ) => void;
  onMove?: (id: string, x: number, y: number) => void;
  onPageChange: (id: string) => void;
  onSelect: (id?: string) => void;
  onZoomChange?: (percent: number) => void;
  originX?: number;
  originY?: number;
  pages: CanvasPage[];
  ref?: Ref<CanvasControls>;
  reservedBottom?: number;
  reservedTop?: number;
  selectedId?: string;
  selectedIds?: string[];
  onSelectMany?: (ids: string[]) => void;
  showSelectionFrame?: boolean;
  width: number;
}

const styles = createStaticStyles(({ css }) => ({
  viewport: css`
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    min-height: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;
    background-color: ${cssVar.colorFillQuaternary};
    background-image: radial-gradient(${cssVar.colorBorderSecondary} 0.75px, transparent 0.75px);
    background-size: 18px 18px;
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -3px;
    }
    &[data-mode='select'],
    &[data-mode='pan'] {
      user-select: none;
      touch-action: none;
    }
    &[data-mode='pan'] {
      cursor: grab;
      touch-action: none;
    }
    &[data-dragging='true'] {
      cursor: grabbing;
    }
  `,
  document: css`
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    &[data-selected='true'] {
      outline: 1px solid ${cssVar.colorPrimaryBorder};
    }
  `,
  pageButton: css`
    position: absolute;
    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 2px;
    background: ${cssVar.colorBgContainer};
    box-shadow: 0 2px 8px #0001;
    cursor: pointer;
    img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
      pointer-events: none;
    }
    &:disabled {
      pointer-events: none;
    }
    &:hover,
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
  `,
  pageLabel: css`
    pointer-events: none;
    position: absolute;
    bottom: calc(100% + 2px);
    left: 0;
    padding-inline: 2px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 14px;
    color: ${cssVar.colorTextSecondary};
  `,
  overlay: css`
    position: absolute;
    z-index: 1;
    inset: 0;
    overflow: hidden;
  `,
}));

const directions: Record<string, [number, number]> = {
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
};
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Keep the document renderer and its source intact underneath the interaction plane. */
export function CanvasSurface({
  children,
  fitPadding = 32,
  height,
  label,
  mode,
  objects,
  onMove,
  onDragPreview,
  expandSelection,
  onFocusPage,
  onGroupShortcut,
  onResize,
  resizeLabel,
  onDocumentTap,
  onClearDocumentSelection,
  onEditSelection,
  onSelect,
  onZoomChange,
  originX = 0,
  originY = 0,
  reservedBottom = 0,
  reservedTop = 0,
  ref,
  boardId,
  pages,
  currentPageId,
  onPageChange,
  selectedId,
  selectedIds,
  onSelectMany,
  showSelectionFrame = true,
  width,
}: CanvasSurfaceProps) {
  const selectionFrame = useRef<HTMLDivElement>(null);
  const activeObject = objects.find((obj) => obj.id === selectedId);
  const selectedItems = objects.filter((o) => selectedIds?.includes(o.id));
  const groupBounds = selectedItems.length > 1 ? selectionBounds(selectedItems) : undefined;
  const selectionBox = groupBounds ?? activeObject;
  const marqueeBox = useRef<HTMLDivElement>(null);
  const marquee = useRef<{
    pointer: number;
    start: Point;
    add: boolean;
    hit?: string;
    moved: boolean;
  }>(undefined);
  const cancelMarquee = () => {
    marquee.current = undefined;
    if (marqueeBox.current) marqueeBox.current.hidden = true;
  };
  useEffect(() => {
    cancelMarquee();
  }, [mode, currentPageId, boardId]);
  const viewport = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });
  const [view, setView] = useState<Camera | 'page' | 'all'>('page');
  const animation = useRef<number>(0);
  const guideX = useRef<HTMLDivElement>(null),
    guideY = useRef<HTMLDivElement>(null);
  const clearGuides = () => {
    if (guideX.current) guideX.current.hidden = true;
    if (guideY.current) guideY.current.hidden = true;
  };
  const resize = useRef<
    | {
        pointer: number;
        x: number;
        y: number;
        signX: number;
        signY: number;
        ax: number;
        ay: number;
        factor: number;
      }
    | undefined
  >(undefined);
  const clickedPage = useRef<string | undefined>(undefined);
  const pointers = useRef(new Map<number, Point>());
  const panPointer = useRef<number | null>(null);
  const down = useRef<Point>({ x: 0, y: 0 });
  const preventClick = useRef(false);
  const pinch = useRef(false);
  const handledDouble = useRef(false);
  const lastPageTap = useRef<{ id: string; time: number; x: number; y: number }>(undefined);
  const tapStart = useRef<(Point & { pointerId: number; page: string }) | undefined>(undefined);
  const [spacePan, setSpacePan] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [engine, setEngine] = useState<{
    konva: typeof Konva;
    layer: Konva.Layer;
    stage: Konva.Stage;
  }>();
  const measured = size.width > 0 && size.height > 0;
  const { frames, bounds } = useMemo(() => arrangePages(pages), [pages]);
  const activePage = frames.find(({ id }) => id === currentPageId);
  const frame = activePage ?? { x: 0, y: 0, width, height };
  const padding = Math.min(fitPadding, size.width * 0.04, size.height * 0.04);
  const top = Math.min(reservedTop, size.height / 4);
  const bottom = Math.min(reservedBottom, size.height / 4);
  const available = {
    x: padding,
    y: top + padding,
    width: Math.max(1, size.width - 2 * padding),
    height: Math.max(1, size.height - top - bottom - 2 * padding),
  };
  const camera =
    typeof view === 'string' ? fitCamera(view === 'all' ? bounds : frame, available) : view;
  const current = useRef(camera);
  current.current = camera;
  const x = camera.x + frame.x * camera.scale;
  const y = camera.y + frame.y * camera.scale;
  const documentWidth = frame.width * camera.scale;
  const documentHeight = frame.height * camera.scale;
  const grid = 18 * (camera.scale / 2 ** Math.floor(Math.log2(camera.scale)));
  const scale = documentWidth / width;
  const scaleY = documentHeight / height;
  const updateCamera = useCallback((next: Camera) => {
    cancelAnimationFrame(animation.current);
    current.current = next;
    setView(next);
  }, []);
  useEffect(() => {
    if (measured) onZoomChange?.(Math.round(camera.scale * 1000) / 10);
  }, [camera.scale, measured, onZoomChange]);
  const panBy = (dx: number, dy: number) => {
    const before = current.current;
    updateCamera({ ...before, x: before.x + dx, y: before.y + dy });
  };
  const zoomBy = useCallback(
    (factor: number) => {
      const center = { x: size.width / 2, y: (size.height + top - bottom) / 2 };
      updateCamera(zoomCamera(current.current, center, center, factor));
    },
    [bottom, size, top, updateCamera],
  );
  useImperativeHandle(
    ref,
    () => ({
      fitPage: () => setView('page'),
      fitAll: () => {
        cancelAnimationFrame(animation.current);
        setView('all');
      },
      zoomBy,
      zoomTo: (scale: number) => zoomBy(scale / current.current.scale),
    }),
    [zoomBy],
  );
  useLayoutEffect(() => {
    if (clickedPage.current !== currentPageId) setView('page');
    clickedPage.current = undefined;
  }, [boardId, currentPageId]);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);
  const selectPage = (id: string) => {
    viewport.current?.focus({ preventScroll: true });
    clickedPage.current = id;
    const target = frames.find((p) => p.id === id);
    if (!target) return;
    onFocusPage?.();
    if (id !== currentPageId) onPageChange(id);
    const from = current.current,
      to = fitCamera(target, available);
    cancelAnimationFrame(animation.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setView('page');
      return;
    }
    const start = performance.now();
    const frame = (now: number) => {
      const f = Math.min(1, (now - start) / 260),
        t = 1 - (1 - f) ** 3;
      if (f === 1) {
        preventClick.current = false;
        setView('page');
        return;
      }
      setView({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        scale: from.scale + (to.scale - from.scale) * t,
      });
      animation.current = requestAnimationFrame(frame);
    };
    animation.current = requestAnimationFrame(frame);
  };

  const interactive = objects.length > 0 && mode === 'select';

  useEffect(() => {
    const host = viewport.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ height: entry.contentRect.height, width: entry.contentRect.width }),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = viewport.current;
    if (!host || mode === 'passive') return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
      const rect = host.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const before = current.current;
      if (
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > Math.abs(event.deltaY))
      ) {
        const dx = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
        updateCamera({
          ...before,
          x: before.x - unit * dx,
          y: before.y - unit * (event.shiftKey ? 0 : event.deltaY),
        });
      } else {
        updateCamera(zoomCamera(before, cursor, cursor, Math.exp(-event.deltaY * unit * 0.003)));
      }
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [mode, updateCamera]);

  useEffect(() => {
    if (!measured || !overlay.current || !interactive) return;
    let canceled = false;
    let stage: Konva.Stage | undefined;
    const container = overlay.current;
    void import('konva')
      .then(({ default: konva }) => {
        if (canceled) return;
        stage = new konva.Stage({ container, height: 1, width: 1 });
        const layer = new konva.Layer();
        stage.add(layer);
        setEngine({ konva, layer, stage });
      })
      .catch(() => {
        // The accessible object picker can still select and place items without Canvas 2D.
      });
    return () => {
      canceled = true;
      stage?.destroy();
      setEngine(undefined);
    };
  }, [measured, interactive]);

  useEffect(() => {
    if (!engine) return;
    const { konva, layer, stage } = engine;
    // Destroying an active Konva node dispatches dragend. Background polling
    // must never commit a pointer gesture while the button is still held.
    if (layer.getChildren().some((node) => node.isDragging())) return;
    stage.size(size);
    layer.destroyChildren();
    for (const object of objects) {
      const selected = object.id === selectedId || !!selectedIds?.includes(object.id);
      const ids =
        selected && selectedIds?.length
          ? selectedIds
          : (expandSelection?.([object.id]) ?? [object.id]);
      const limits =
        ids.length > 1 ? selectionBounds(objects.filter((o) => ids.includes(o.id))) : object;
      const anchors = (vertical: boolean) => {
        const axis = vertical ? 'y' : 'x',
          extent = vertical ? 'height' : 'width',
          min = vertical ? originY : originX,
          length = vertical ? height : width;
        return [
          min,
          min + length / 2,
          min + length,
          ...objects
            .filter((o) => !ids.includes(o.id))
            .flatMap((o) => [o[axis], o[axis] + o[extent] / 2, o[axis] + o[extent]]),
        ];
      };
      const xAnchors = anchors(false),
        yAnchors = anchors(true);
      const w = object.width * scale,
        h = object.height * scaleY;
      const item = new konva.Group({
        x: x + (object.x - originX) * scale,
        y: y + (object.y - originY) * scaleY,
        id: object.id,
        draggable: Boolean(onMove),
        dragBoundFunc: (position) => {
          const snap = (vertical: boolean) => {
            const axis = vertical ? 'y' : 'x',
              extent = vertical ? 'height' : 'width',
              unit = vertical ? scaleY : scale;
            const pageStart = vertical ? originY : originX,
              length = vertical ? height : width,
              screen = vertical ? y : x;
            const shift = object[axis] - limits[axis];
            const raw = pageStart + (position[axis] - screen) / unit - shift;
            const { delta, guide } = snapAxis(
              raw,
              limits[extent],
              vertical ? yAnchors : xAnchors,
              4 / unit,
            );
            const clamped = clamp(raw + delta, pageStart, pageStart + length - limits[extent]);
            const line = vertical ? guideY.current : guideX.current;
            if (line) {
              line.hidden = guide === undefined || Math.abs(clamped - raw - delta) > 0.01;
              if (guide !== undefined)
                line.style[vertical ? 'top' : 'left'] = screen + (guide - pageStart) * unit + 'px';
            }
            return screen + (clamped + shift - pageStart) * unit;
          };
          return { x: snap(false), y: snap(true) };
        },
      });
      item.add(
        new konva.Rect({
          width: w,
          height: h,
          fill: 'rgba(0,0,0,0.001)',
        }),
      );
      item.on('click tap', (event) => {
        event.cancelBubble = true;
        onSelect(object.id);
        viewport.current?.focus({ preventScroll: true });
      });
      item.on('dragmove', () => {
        if (selected && selectionFrame.current)
          selectionFrame.current.style.translate = `${item.x() - x - (object.x - originX) * scale}px ${item.y() - y - (object.y - originY) * scaleY}px`;

        onDragPreview?.(
          object.id,
          (item.x() - x) / scale + originX - object.x,
          (item.y() - y) / scaleY + originY - object.y,
        );
      });
      item.on('dragend', () => {
        clearGuides();
        if (selectionFrame.current) selectionFrame.current.style.translate = '';
        if (!pinch.current)
          onMove?.(object.id, originX + (item.x() - x) / scale, originY + (item.y() - y) / scaleY);
        onDragPreview?.();
        viewport.current?.focus({ preventScroll: true });
      });
      item.on('mouseenter', () => {
        stage.container().style.cursor = onMove ? 'move' : 'pointer';
      });
      item.on('mouseleave', () => {
        stage.container().style.cursor = '';
      });
      layer.add(item);
    }
    stage.on('click.background tap.background', (event) => {
      if (event.target === stage) onSelect();
    });
    layer.batchDraw();
    return () => {
      stage.off('.background');
    };
  }, [
    documentHeight,
    documentWidth,
    engine,
    objects,
    onDragPreview,
    onMove,
    onSelect,
    originX,
    originY,
    scale,
    scaleY,
    selectedId,
    selectedIds,
    size,
    x,
    y,
  ]);

  const pageAt = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    return overlay.current?.contains(target)
      ? currentPageId
      : target.closest<HTMLElement>('[data-canvas-page]')?.dataset.canvasPage;
  };
  const point = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const worldPageAt = (pos: Point) => {
    const camera = current.current;
    const wx = (pos.x - camera.x) / camera.scale,
      wy = (pos.y - camera.y) / camera.scale;
    return frames.find(
      (page) =>
        wx >= page.x && wx <= page.x + page.width && wy >= page.y && wy <= page.y + page.height,
    )?.id;
  };
  const endTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = tapStart.current;
    tapStart.current = undefined;
    if (!start || start.pointerId !== event.pointerId || pinch.current || preventClick.current)
      return;
    const pos = point(event);
    const id = worldPageAt(pos);
    if (start.page !== id || Math.hypot(pos.x - start.x, pos.y - start.y) > 6) return;
    if (
      id &&
      (id !== currentPageId ||
        view === 'all' ||
        camera.scale < fitCamera(frame, available).scale * 0.72)
    ) {
      preventClick.current = true;
      lastPageTap.current = undefined;
      selectPage(id);
      return;
    }
    const previous = lastPageTap.current;
    if (
      event.pointerType === 'touch' &&
      previous?.id === id &&
      event.timeStamp - previous.time < 500 &&
      Math.hypot(pos.x - previous.x, pos.y - previous.y) < 6
    ) {
      lastPageTap.current = undefined;
      preventClick.current = true;
      handledDouble.current =
        id === currentPageId &&
        Boolean(
          onDocumentTap?.(
            { x: (pos.x - x) / documentWidth, y: (pos.y - y) / documentHeight },
            true,
          ),
        );
      if (!handledDouble.current) {
        setView('page');
        viewport.current?.focus({ preventScroll: true });
      }
    } else {
      handledDouble.current = false;
      if (id === currentPageId)
        onDocumentTap?.({ x: (pos.x - x) / documentWidth, y: (pos.y - y) / documentHeight }, false);
      lastPageTap.current = { id, time: event.timeStamp, ...pos };
    }
  };
  const endPointer = (id: number) => {
    pointers.current.delete(id);
    if (panPointer.current === id) panPointer.current = null;
    if (pointers.current.size === 0) {
      setDragging(false);
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    if ((e.target as Element).closest?.('[data-resize-handle]')) return;
    if (mode === 'passive' || (e.button !== 0 && e.button !== 1)) return;
    if (!pointers.current.size) {
      preventClick.current = false;
      pinch.current = false;
    }
    const pos = point(e);
    pointers.current.set(e.pointerId, pos);
    const page = worldPageAt(pos);
    tapStart.current =
      mode === 'select' && !spacePan && e.button === 0 && pointers.current.size === 1 && page
        ? { ...pos, page, pointerId: e.pointerId }
        : undefined;
    if (!tapStart.current) lastPageTap.current = undefined;
    if (pointers.current.size >= 2) {
      cancelMarquee();
      pinch.current = true;
      preventClick.current = true;
      engine?.stage.find('Group').forEach((node) => {
        if (node.isDragging()) node.stopDrag();
      });
      onDragPreview?.();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    const pageX = originX + (pos.x - x) / scale,
      pageY = originY + (pos.y - y) / scaleY;
    const hit =
      page === currentPageId
        ? objects.findLast(
            (o) =>
              pageX >= o.x && pageX <= o.x + o.width && pageY >= o.y && pageY <= o.y + o.height,
          )?.id
        : undefined;
    if (
      onSelectMany &&
      mode === 'select' &&
      !spacePan &&
      !pinch.current &&
      e.button === 0 &&
      e.pointerType !== 'touch' &&
      view !== 'all' &&
      camera.scale >= fitCamera(frame, available).scale * 0.72 &&
      (!page || page === currentPageId) &&
      (!hit || e.shiftKey)
    ) {
      marquee.current = {
        pointer: e.pointerId,
        start: pos,
        add: e.shiftKey,
        hit: hit || undefined,
        moved: false,
      };
      tapStart.current = undefined;
      lastPageTap.current = undefined;
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
      e.stopPropagation();
      return;
    }
    const emptySpace = e.target === e.currentTarget;
    const touchPan = e.pointerType === 'touch' && !engine?.stage.getIntersection(pos);
    if (spacePan || mode === 'pan' || e.button === 1 || emptySpace || touchPan) {
      down.current = pos;
      panPointer.current = e.pointerId;
      if (e.button === 1) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      e.currentTarget.focus({ preventScroll: true });
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const points = pointers.current;
    const last = points.get(e.pointerId);
    if (!last) return;
    const pos = point(e);
    const gesture = marquee.current;
    if (gesture && gesture.pointer === e.pointerId && !pinch.current) {
      if (!gesture.hit && Math.hypot(pos.x - gesture.start.x, pos.y - gesture.start.y) >= 3)
        gesture.moved = true;
      const el = marqueeBox.current;
      if (gesture.moved && el) {
        el.hidden = false;
        Object.assign(el.style, {
          left: Math.min(pos.x, gesture.start.x) + 'px',
          top: Math.min(pos.y, gesture.start.y) + 'px',
          width: Math.abs(pos.x - gesture.start.x) + 'px',
          height: Math.abs(pos.y - gesture.start.y) + 'px',
        });
      }
      points.set(e.pointerId, pos);
      e.stopPropagation();
      return;
    }
    if (points.size === 2) {
      const other = [...points].find(([id]) => id !== e.pointerId)![1];
      const oldDistance = Math.hypot(last.x - other.x, last.y - other.y);
      const newDistance = Math.hypot(pos.x - other.x, pos.y - other.y);
      if (oldDistance > 1 && newDistance > 1)
        updateCamera(
          zoomCamera(
            current.current,
            midpoint(last, other),
            midpoint(pos, other),
            newDistance / oldDistance,
          ),
        );
      e.stopPropagation();
    } else if (panPointer.current === e.pointerId && !pinch.current) {
      if (!preventClick.current && Math.hypot(pos.x - down.current.x, pos.y - down.current.y) < 4)
        return;
      preventClick.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      panBy(pos.x - last.x, pos.y - last.y);
      e.stopPropagation();
    }
    points.set(e.pointerId, pos);
  };

  return (
    <div
      aria-label={label}
      className={styles.viewport}
      data-dragging={dragging}
      data-mode={spacePan ? 'pan' : mode}
      data-scale={camera.scale}
      data-testid="spatial-canvas"
      ref={viewport}
      role="region"
      tabIndex={0}
      style={{
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      }}
      onBlur={() => setSpacePan(false)}
      onLostPointerCapture={(event) => {
        if (marquee.current?.pointer === event.pointerId) cancelMarquee();
        endPointer(event.pointerId);
      }}
      onPointerCancel={(event) => {
        cancelMarquee();
        endPointer(event.pointerId);
      }}
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onClickCapture={(event) => {
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (preventClick.current || spacePan || mode === 'pan') {
          event.stopPropagation();
          event.preventDefault();
          preventClick.current = false;
          return;
        }
        if (mode !== 'select' || !(event.target instanceof Element)) return;
        const target = event.target;
        const pageId = pageAt(target);
        if (!pageId) {
          onClearDocumentSelection?.();
          onSelect();
          return;
        }
        if (pageId === currentPageId && !overlay.current?.contains(target)) {
          onSelect();
          viewport.current?.focus({ preventScroll: true });
        }
      }}
      onDoubleClickCapture={(event) => {
        if (
          mode !== 'select' ||
          spacePan ||
          event.button !== 0 ||
          pageAt(event.target) !== currentPageId ||
          (event.target as Element).closest('[data-resize-handle]')
        )
          return;
        const box = event.currentTarget.getBoundingClientRect();
        const hit = onDocumentTap?.(
          {
            x: (event.clientX - box.left - x) / documentWidth,
            y: (event.clientY - box.top - y) / documentHeight,
          },
          true,
        );
        if (hit) {
          event.preventDefault();
          event.stopPropagation();
        } else if (!handledDouble.current) selectPage(currentPageId);
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'g' &&
          onGroupShortcut
        ) {
          event.preventDefault();
          if (!event.repeat) onGroupShortcut(event.shiftKey);
          return;
        }
        if (
          event.target === event.currentTarget &&
          !event.altKey &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'a' &&
          mode === 'select' &&
          onSelectMany
        ) {
          event.preventDefault();
          onSelectMany(objects.map((o) => o.id));
          return;
        }
        if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey)
          return;
        if (event.key === 'Escape' && marquee.current) {
          cancelMarquee();
          preventClick.current = true;
          event.preventDefault();
          return;
        }
        if (event.code === 'Space') {
          event.preventDefault();
          setSpacePan(true);
          return;
        }
        if (event.key === 'Escape' && (onClearDocumentSelection?.() || selectedId)) {
          event.preventDefault();
          onSelect();
          return;
        }
        if (event.key === 'Enter' && mode === 'select' && onEditSelection?.()) {
          event.preventDefault();
          return;
        }
        if (event.key === 'Enter' && mode === 'select' && !selectedId) {
          event.preventDefault();
          setView('page');
          return;
        }
        const direction = directions[event.key];
        if (!direction) return;
        const selected = objects.find(({ id }) => id === selectedId);
        if (mode === 'pan' || spacePan) {
          event.preventDefault();
          panBy(direction[0] * 32, direction[1] * 32);
        } else if (mode === 'select' && selected && onMove) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          onMove(
            selected.id,
            clamp(selected.x + direction[0] * step, originX, originX + width - selected.width),
            clamp(selected.y + direction[1] * step, originY, originY + height - selected.height),
          );
        }
      }}
      onKeyUp={(event) => {
        if (event.code === 'Space') setSpacePan(false);
      }}
      onPointerLeave={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) endPointer(event.pointerId);
      }}
      onPointerUpCapture={(event) => {
        const gesture = marquee.current;
        if (gesture?.pointer === event.pointerId && onSelectMany) {
          const pos = point(event),
            start = gesture.start;
          const minX = originX + (Math.min(pos.x, start.x) - x) / scale,
            maxX = originX + (Math.max(pos.x, start.x) - x) / scale;
          const minY = originY + (Math.min(pos.y, start.y) - y) / scaleY,
            maxY = originY + (Math.max(pos.y, start.y) - y) / scaleY;
          const hits = gesture.moved
            ? objects
                .filter(
                  (o) =>
                    o.x >= minX && o.x + o.width <= maxX && o.y >= minY && o.y + o.height <= maxY,
                )
                .map((o) => o.id)
            : gesture.hit
              ? [gesture.hit]
              : [];
          const previous = selectedIds?.length ? selectedIds : selectedId ? [selectedId] : [];
          const fullHits = expandSelection?.(hits) ?? hits;
          const next = gesture.add
            ? !gesture.moved && gesture.hit && previous.includes(gesture.hit)
              ? previous.filter((id) => !fullHits.includes(id))
              : [...new Set([...previous, ...fullHits])]
            : fullHits;
          onSelectMany(next);
          cancelMarquee();
          endPointer(event.pointerId);
          preventClick.current = true;
          event.stopPropagation();
          return;
        }
        endTap(event);
        endPointer(event.pointerId);
      }}
    >
      {measured &&
        frames.map((page) => {
          if (page.id === currentPageId) return null;
          const left = page.x * camera.scale + camera.x,
            top = page.y * camera.scale + camera.y;
          const w = page.width * camera.scale,
            h = page.height * camera.scale;
          if (left + w < -24 || top + h < -24 || left > size.width + 24 || top > size.height + 24)
            return null;
          return (
            <button
              aria-label={page.label}
              className={styles.pageButton}
              data-canvas-page={page.id}
              data-testid={`spatial-page-${page.id}`}
              disabled={mode !== 'select' || spacePan}
              key={page.id}
              style={{ left, top, width: w, height: h }}
              type="button"
              onClick={() => selectPage(page.id)}
            >
              {w > 45 && <span className={styles.pageLabel}>{page.label}</span>}
              {page.preview && <img alt="" draggable={false} src={page.preview} />}
            </button>
          );
        })}
      <div
        aria-current="page"
        className={styles.document}
        data-canvas-page={currentPageId}
        data-selected="true"
        data-testid={`spatial-page-${currentPageId}`}
        style={
          measured
            ? {
                position: 'absolute',
                left: x,
                top: y,
                width: documentWidth,
                height: documentHeight,
                pointerEvents: mode === 'pan' ? 'none' : undefined,
              }
            : undefined
        }
      >
        {measured && pages.length > 1 && documentWidth > 45 && (
          <span className={styles.pageLabel}>{activePage?.label}</span>
        )}
        {children}
      </div>
      {showSelectionFrame && selectionBox && mode === 'select' && measured && (
        <div
          key={selectedIds?.join() ?? selectedId}
          data-testid="canvas-selection-frame"
          ref={selectionFrame}
          className={glassSelection}
          style={{
            position: 'absolute',
            zIndex: 2,
            left: x + (selectionBox.x - originX) * scale,
            top: y + (selectionBox.y - originY) * scaleY,
            width: selectionBox.width * scale,
            height: selectionBox.height * scaleY,
          }}
        >
          {groupBounds &&
            selectedItems.map((o) => (
              <span
                key={o.id}
                data-selected-object={o.id}
                style={{
                  position: 'absolute',
                  border: '1px solid currentColor',
                  opacity: 0.55,
                  left: (o.x - groupBounds.x) * scale,
                  top: (o.y - groupBounds.y) * scaleY,
                  width: o.width * scale,
                  height: o.height * scaleY,
                  boxSizing: 'border-box',
                }}
              />
            ))}
          {groupBounds &&
            onResize &&
            (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
              const right = corner.endsWith('e'),
                bottom = corner.startsWith('s');
              return (
                <button
                  key={corner}
                  data-resize-handle={corner}
                  aria-label={resizeLabel}
                  type="button"
                  style={{
                    position: 'absolute',
                    left: right ? '100%' : '0%',
                    top: bottom ? '100%' : '0%',
                    translate: '-50% -50%',
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    border: '1px solid currentColor',
                    background: 'var(--qz-glass-tint, #d8ece8)',
                    padding: 0,
                    pointerEvents: 'auto',
                    touchAction: 'none',
                    cursor: right === bottom ? 'nwse-resize' : 'nesw-resize',
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    resize.current = {
                      pointer: e.pointerId,
                      x: e.clientX,
                      y: e.clientY,
                      signX: right ? 1 : -1,
                      signY: bottom ? 1 : -1,
                      ax: groupBounds.x + (right ? 0 : groupBounds.width),
                      ay: groupBounds.y + (bottom ? 0 : groupBounds.height),
                      factor: 1,
                    };
                  }}
                  onPointerMove={(e) => {
                    const g = resize.current;
                    if (!g || g.pointer !== e.pointerId) return;
                    const w = groupBounds.width * scale,
                      h = groupBounds.height * scaleY;
                    const maxX =
                        (right ? originX + width - g.ax : g.ax - originX) / groupBounds.width,
                      maxY =
                        (bottom ? originY + height - g.ay : g.ay - originY) / groupBounds.height;
                    g.factor = clamp(
                      1 +
                        ((e.clientX - g.x) * g.signX * w + (e.clientY - g.y) * g.signY * h) /
                          (w * w + h * h),
                      0.05,
                      Math.min(20, maxX, maxY),
                    );
                    if (selectionFrame.current) {
                      selectionFrame.current.style.transformOrigin =
                        (right ? 'left' : 'right') + ' ' + (bottom ? 'top' : 'bottom');
                      selectionFrame.current.style.transform = 'scale(' + g.factor + ')';
                    }
                    onDragPreview?.(selectedIds?.[0], 0, 0, g.factor, g.ax, g.ay);
                  }}
                  onPointerCancel={() => {
                    resize.current = undefined;
                    if (selectionFrame.current) selectionFrame.current.style.transform = '';
                    onDragPreview?.();
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    const g = resize.current;
                    if (!g || g.pointer !== e.pointerId) return;
                    resize.current = undefined;
                    if (selectionFrame.current) selectionFrame.current.style.transform = '';
                    if (Math.abs(1 - g.factor) > 0.0001) onResize(g.factor, g.ax, g.ay);
                    onDragPreview?.();
                    viewport.current?.focus({ preventScroll: true });
                  }}
                />
              );
            })}
        </div>
      )}
      <div
        hidden
        ref={guideX}
        data-snap-guide="x"
        style={{
          position: 'absolute',
          pointerEvents: 'none',
          zIndex: 4,
          top: y,
          height: documentHeight,
          borderLeft: '1px dashed #b353a4',
        }}
      />
      <div
        hidden
        ref={guideY}
        data-snap-guide="y"
        style={{
          position: 'absolute',
          pointerEvents: 'none',
          zIndex: 4,
          left: x,
          width: documentWidth,
          borderTop: '1px dashed #b353a4',
        }}
      />
      <div
        hidden
        aria-hidden
        ref={marqueeBox}
        data-testid="canvas-marquee"
        className={glassSelection}
        style={{ position: 'absolute', zIndex: 3, animation: 'none' }}
      />
      <div
        aria-hidden
        className={styles.overlay}
        ref={overlay}
        style={{
          pointerEvents: interactive && engine && !spacePan ? 'auto' : 'none',
          clipPath: `inset(${Math.max(0, y)}px ${Math.max(0, size.width - x - documentWidth)}px ${Math.max(0, size.height - y - documentHeight)}px ${Math.max(0, x)}px)`,
        }}
      />
    </div>
  );
}
