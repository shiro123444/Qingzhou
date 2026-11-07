'use client';

import {
  type ChangeEvent as ReactChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  clampDockPoint,
  defaultDockPoint,
  DOCK_DRAG_THRESHOLD,
  type DockAnchor,
  dockAnchorToPoint,
  dockPanelLayout,
  type DockPoint,
  dockPointToAnchor,
  dockPositionKey,
  type DockRect,
  type DockSize,
  type DockViewport,
  parseDockPosition,
  placeDock,
  serializeDockPosition,
} from './dock-position';

interface DockGeometry {
  offsetX: number;
  offsetY: number;
  panelMaxHeight: number;
  panelSide: 'above' | 'below';
  point: DockPoint;
  rootWidth: number;
  rtl: boolean;
  size: DockSize;
  viewport: DockViewport;
}
interface DragSession {
  anchor: DockAnchor | null;
  armed: boolean;
  captured: boolean;
  captureElement: HTMLElement;
  moved: boolean;
  pendingRange?: { commit: (value: number) => void; value: number };
  pointerId: number;
  range: HTMLInputElement | null;
  rangeScrubbing: boolean;
  start: DockPoint;
  startX: number;
  startY: number;
  timer?: ReturnType<typeof setTimeout>;
  userId: string;
}

export const CAPSULE_RANGE_HOLD_MS = 180;

const readViewport = (): DockViewport => {
  const viewport = window.visualViewport;
  return {
    x: viewport?.offsetLeft ?? 0,
    y: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
};

const avoidRects = (viewport: DockViewport): DockRect[] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-music-player-avoid], [data-music-avoid="composer"]',
    ),
  ]
    .filter((node) => {
      const style = getComputedStyle(node);
      return (
        node.getClientRects().length > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    })
    .map((node) => node.getBoundingClientRect())
    .filter(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > viewport.y &&
        rect.top < viewport.y + viewport.height,
    )
    .slice(0, 12)
    .map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));

/** Presentation-only state: never creates, pauses or replaces the media engine. */
export function useCapsulePosition({
  collapsed,
  details,
  dock,
  routeKey,
  userId,
}: {
  collapsed: boolean;
  details: boolean;
  dock: RefObject<HTMLElement | null>;
  routeKey: string;
  userId: string | null;
}) {
  const preferred = useRef<{ userId: string | null; anchor: DockAnchor | null }>({
    userId: null,
    anchor: null,
  });
  const drag = useRef<DragSession | null>(null);
  const suppressClick = useRef(false);
  const blockedRange = useRef<HTMLInputElement | null>(null);
  const latestPointer = useRef<DockPoint>({ x: 0, y: 0 });
  const moveRef = useRef<(event: PointerEvent) => void>(() => {});
  const finishRef = useRef<(pointerId: number, cancelled: boolean) => void>(() => {});
  const [rangePreview, setRangePreview] = useState<{ id: string; value: number } | null>(null);
  const geometry = useRef<DockGeometry | null>(null);
  const measureRef = useRef<() => void>(() => {});
  const [layout, setLayout] = useState<DockGeometry | null>(null);
  const [dragging, setDragging] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);

  const measure = useCallback(() => {
    const root = dock.current;
    const body = root?.querySelector<HTMLElement>('[data-capsule-body]');
    if (!root || !body || !userId || preferred.current.userId !== userId) return;
    const rect = body.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const rootRect = root.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const viewport = readViewport();
    const obstacles = avoidRects(viewport);
    const anchor = drag.current?.anchor ?? preferred.current.anchor;
    const wanted = anchor
      ? dockAnchorToPoint(anchor, size, viewport)
      : defaultDockPoint(size, viewport, collapsed);
    const point = placeDock(wanted, size, viewport, obstacles);
    const panel = dockPanelLayout(point, size, viewport, obstacles);
    const next: DockGeometry = {
      point,
      size,
      viewport,
      offsetX: rect.left - rootRect.left,
      offsetY: rect.top - rootRect.top,
      rootWidth: rootRect.width,
      rtl: getComputedStyle(root).direction === 'rtl',
      panelSide: panel.side,
      panelMaxHeight: panel.maxHeight,
    };
    geometry.current = next;
    setLayout((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [collapsed, dock, userId]);
  measureRef.current = measure;

  useLayoutEffect(() => {
    if (drag.current) {
      clearTimeout(drag.current.timer);
      const active = drag.current;
      drag.current = null;
      try {
        if (active.captureElement.hasPointerCapture(active.pointerId))
          active.captureElement.releasePointerCapture(active.pointerId);
      } catch {
        /* A detached surface no longer owns pointer capture. */
      }
    }
    blockedRange.current = null;
    setRangePreview(null);
    suppressClick.current = false;
    setDragging(false);
    setStorageWarning(false);
    let anchor: DockAnchor | null = null;
    if (userId)
      try {
        anchor = parseDockPosition(localStorage.getItem(dockPositionKey(userId)));
      } catch {
        setStorageWarning(true);
      }
    preferred.current = { userId, anchor };
    measureRef.current();
  }, [userId]);

  useLayoutEffect(() => {
    if (!userId || !dock.current) return;
    let frame = 0;
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const observed = new Set<Element>();
    const measureAndObserve = () => {
      measureRef.current();
      const nodes: Element[] = [
        dock.current!,
        ...document.querySelectorAll('[data-music-player-avoid], [data-music-avoid="composer"]'),
      ];
      const body = dock.current?.querySelector('[data-capsule-body]');
      if (body) nodes.push(body);
      const next = new Set(nodes);
      for (const old of observed)
        if (!next.has(old)) {
          resizeObserver?.unobserve(old);
          observed.delete(old);
        }
      for (const node of next)
        if (!observed.has(node)) {
          resizeObserver?.observe(node);
          observed.add(node);
        }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureAndObserve);
    };
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'dir'],
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    measureAndObserve();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [collapsed, details, dock, routeKey, userId]);

  const save = (anchor: DockAnchor | null) => {
    if (!userId || preferred.current.userId !== userId) return;
    preferred.current = { userId, anchor };
    try {
      if (anchor) localStorage.setItem(dockPositionKey(userId), serializeDockPosition(anchor));
      else localStorage.removeItem(dockPositionKey(userId));
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
    measureRef.current();
  };
  const reset = () => save(null);

  const onPointerDownCapture = (event: ReactPointerEvent<HTMLElement>) => {
    if (!userId || !event.isPrimary || event.button !== 0 || !geometry.current) return;
    // A new gesture also releases suppression when a touch drag emitted no click.
    suppressClick.current = false;
    // Details/queue panels remain scrollable and keep ordinary input behavior.
    if (!(event.target instanceof Element) || !event.target.closest('[data-capsule-body]')) return;
    if (drag.current) finishRef.current(drag.current.pointerId, true);
    blockedRange.current = null;
    const range =
      event.target instanceof Element
        ? event.target.closest<HTMLInputElement>('input[type="range"]')
        : null;
    const active: DragSession = {
      pointerId: event.pointerId,
      userId,
      captureElement: event.currentTarget,
      captured: false,
      range,
      rangeScrubbing: false,
      armed: !range,
      startX: event.clientX,
      startY: event.clientY,
      start: geometry.current.point,
      moved: false,
      anchor: null,
    };
    latestPointer.current = { x: event.clientX, y: event.clientY };
    drag.current = active;
    if (range) {
      active.timer = setTimeout(() => {
        if (
          drag.current !== active ||
          preferred.current.userId !== active.userId ||
          active.rangeScrubbing
        )
          return;
        active.armed = true;
        active.startX = latestPointer.current.x;
        active.startY = latestPointer.current.y;
        active.start = geometry.current?.point ?? active.start;
      }, CAPSULE_RANGE_HOLD_MS);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const active = drag.current;
    const measured = geometry.current;
    if (!active || active.pointerId !== event.pointerId || active.userId !== userId || !measured)
      return;
    latestPointer.current = { x: event.clientX, y: event.clientY };
    if (!active.armed) {
      // A scrub begun before the hold deadline stays a scrub for its entire gesture.
      if (
        active.range &&
        Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >=
          DOCK_DRAG_THRESHOLD
      ) {
        active.rangeScrubbing = true;
        clearTimeout(active.timer);
      }
      return;
    }
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < DOCK_DRAG_THRESHOLD) return;
    if (!active.captured) {
      try {
        active.captureElement.setPointerCapture(event.pointerId);
      } catch {
        finishRef.current(event.pointerId, true);
        return;
      }
      active.captured = true;
      active.pendingRange = undefined;
      setRangePreview(null);
      dock.current
        ?.querySelector<HTMLElement>('[data-capsule-body]')
        ?.focus({ preventScroll: true });
    }
    active.moved = true;
    event.preventDefault();
    const point = clampDockPoint(
      { x: active.start.x + dx, y: active.start.y + dy },
      measured.size,
      measured.viewport,
    );
    active.anchor = dockPointToAnchor(point, measured.size, measured.viewport);
    setDragging(true);
    measureRef.current();
  };
  moveRef.current = onPointerMove;

  const finishPointer = (pointerId: number, cancelled: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== pointerId) return;
    clearTimeout(active.timer);
    drag.current = null;
    setDragging(false);
    setRangePreview(null);
    suppressClick.current = !cancelled && active.moved;
    blockedRange.current = active.range;
    if (!cancelled && active.userId === userId) {
      if (active.moved && active.anchor) save(active.anchor);
      else {
        active.pendingRange?.commit(active.pendingRange.value);
        measureRef.current();
      }
    } else measureRef.current();
    try {
      if (active.captured && active.captureElement.hasPointerCapture(pointerId))
        active.captureElement.releasePointerCapture(pointerId);
    } catch {
      /* Native range capture may have already ended. */
    }
  };
  finishRef.current = finishPointer;

  useLayoutEffect(() => {
    const move = (event: PointerEvent) => moveRef.current(event);
    const up = (event: PointerEvent) => finishRef.current(event.pointerId, false);
    const cancel = (event: PointerEvent) => finishRef.current(event.pointerId, true);
    const blur = () => {
      if (drag.current) finishRef.current(drag.current.pointerId, true);
    };
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', blur);
      const active = drag.current;
      if (active) {
        clearTimeout(active.timer);
        drag.current = null;
        try {
          if (active.captureElement.hasPointerCapture(active.pointerId))
            active.captureElement.releasePointerCapture(active.pointerId);
        } catch {
          /* Unmount releases capture without touching audio. */
        }
      }
    };
  }, []);

  const onLostPointerCaptureCapture = (event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (active?.captured && event.target === active.captureElement)
      finishPointer(event.pointerId, true);
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current || event.detail === 0) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && drag.current) {
      event.preventDefault();
      finishPointer(drag.current.pointerId, true);
      return;
    }
    if (event.target instanceof HTMLInputElement && event.target.type === 'range') {
      blockedRange.current = null;
      return;
    }
    // Child controls keep their own arrow/Home semantics. Only the focused body moves.
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute('data-capsule-body'))
      return;
    if (event.key === 'Home') {
      event.preventDefault();
      reset();
      return;
    }
    const delta = (
      { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const
    )[event.key as 'ArrowLeft'];
    const measured = geometry.current;
    if (!delta || !measured) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const point = clampDockPoint(
      { x: measured.point.x + delta[0] * step, y: measured.point.y + delta[1] * step },
      measured.size,
      measured.viewport,
    );
    save(dockPointToAnchor(point, measured.size, measured.viewport));
  };

  const changeRange = (
    event: ReactChangeEvent<HTMLInputElement>,
    commit: (value: number) => void,
  ) => {
    const input = event.currentTarget;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const active = drag.current;
    if (active?.range === input) {
      if (active.moved) return;
      active.pendingRange = { commit, value };
      setRangePreview({ id: input.dataset.capsuleRange ?? '', value });
      return;
    }
    if (blockedRange.current === input) return;
    commit(value);
  };

  const left = layout ? layout.point.x - layout.offsetX : 0;
  const top = layout ? layout.point.y - layout.offsetY : 0;
  const style: CSSProperties | undefined = layout
    ? ({
        'insetInlineStart': layout.rtl ? window.innerWidth - left - layout.rootWidth : left,
        'insetInlineEnd': 'auto',
        'insetBlockStart': top,
        'insetBlockEnd': 'auto',
        '--music-panel-max-height': `${layout.panelMaxHeight}px`,
      } as CSSProperties)
    : undefined;

  return {
    style,
    dragging,
    ready: !!layout,
    panelSide: layout?.panelSide ?? 'above',
    storageWarning,
    reset,
    rangeValue: (id: string, fallback: number) =>
      rangePreview?.id === id ? rangePreview.value : fallback,
    changeRange,
    surfaceProps: {
      onPointerDownCapture,
      onLostPointerCaptureCapture,
      onClickCapture,
      onKeyDownCapture,
      onDragStartCapture: (event: ReactDragEvent<HTMLElement>) => event.preventDefault(),
    },
  };
}
