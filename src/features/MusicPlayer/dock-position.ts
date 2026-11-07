/** Position preferences store the capsule's trailing/bottom anchor, independent of its size. */
export interface DockAnchor {
  x: number;
  y: number;
}
export interface DockPoint {
  x: number;
  y: number;
}
export interface DockSize {
  height: number;
  width: number;
}
export interface DockRect extends DockPoint, DockSize {}
export interface DockViewport extends DockRect {}

export const DOCK_MARGIN = 12;
export const DOCK_GAP = 10;
export const DOCK_PANEL_GAP = 12;
export const DOCK_DRAG_THRESHOLD = 6;

export const dockPositionKey = (userId: string) =>
  `qingzhou:music:dock:v1:${encodeURIComponent(userId)}`;

/** Storage is untrusted: accept only the small, versioned position record. */
export function parseDockPosition(raw: string | null): DockAnchor | null {
  if (!raw || raw.length > 256) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || record.version !== 1) return null;
    const anchor = record.anchor;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
    const point = anchor as Record<string, unknown>;
    if (Object.keys(point).length !== 2) return null;
    if (
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1
    )
      return null;
    return { x: point.x, y: point.y };
  } catch {
    return null;
  }
}

export const serializeDockPosition = (anchor: DockAnchor) => JSON.stringify({ version: 1, anchor });

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(Math.max(minimum, maximum), Number.isFinite(value) ? value : minimum));

export function clampDockPoint(
  point: DockPoint,
  size: DockSize,
  viewport: DockViewport,
): DockPoint {
  return {
    x: clamp(
      point.x,
      viewport.x + DOCK_MARGIN,
      viewport.x + viewport.width - size.width - DOCK_MARGIN,
    ),
    y: clamp(
      point.y,
      viewport.y + DOCK_MARGIN,
      viewport.y + viewport.height - size.height - DOCK_MARGIN,
    ),
  };
}

export function dockAnchorToPoint(
  anchor: DockAnchor,
  size: DockSize,
  viewport: DockViewport,
): DockPoint {
  return {
    x: viewport.x + anchor.x * viewport.width - size.width,
    y: viewport.y + anchor.y * viewport.height - size.height,
  };
}

export function dockPointToAnchor(
  point: DockPoint,
  size: DockSize,
  viewport: DockViewport,
): DockAnchor {
  return {
    x: clamp((point.x + size.width - viewport.x) / Math.max(1, viewport.width), 0, 1),
    y: clamp((point.y + size.height - viewport.y) / Math.max(1, viewport.height), 0, 1),
  };
}

export const defaultDockPoint = (
  size: DockSize,
  viewport: DockViewport,
  collapsed: boolean,
): DockPoint =>
  clampDockPoint(
    {
      x: viewport.x + viewport.width - size.width - 24,
      y: viewport.y + viewport.height - size.height - (collapsed ? 24 : 108),
    },
    size,
    viewport,
  );

export const dockOverlapArea = (point: DockPoint, size: DockSize, rect: DockRect, gap = DOCK_GAP) =>
  Math.max(
    0,
    Math.min(point.x + size.width, rect.x + rect.width + gap) - Math.max(point.x, rect.x - gap),
  ) *
  Math.max(
    0,
    Math.min(point.y + size.height, rect.y + rect.height + gap) - Math.max(point.y, rect.y - gap),
  );

/** Project a preference to the nearest available space; never mutate the stored preference. */
export function placeDock(
  wanted: DockPoint,
  size: DockSize,
  viewport: DockViewport,
  obstacles: readonly DockRect[],
): DockPoint {
  const initial = clampDockPoint(wanted, size, viewport);
  const avoid = obstacles.slice(0, 12);
  const overlap = (point: DockPoint) =>
    avoid.reduce((sum, rect) => sum + dockOverlapArea(point, size, rect), 0);
  if (overlap(initial) === 0) return initial;

  const xs = new Set<number>([
    initial.x,
    viewport.x + DOCK_MARGIN,
    viewport.x + viewport.width - size.width - DOCK_MARGIN,
  ]);
  const ys = new Set<number>([
    initial.y,
    viewport.y + DOCK_MARGIN,
    viewport.y + viewport.height - size.height - DOCK_MARGIN,
  ]);
  for (const rect of avoid) {
    xs.add(rect.x - size.width - DOCK_GAP);
    xs.add(rect.x + rect.width + DOCK_GAP);
    ys.add(rect.y - size.height - DOCK_GAP);
    ys.add(rect.y + rect.height + DOCK_GAP);
  }
  let best = initial;
  let bestArea = overlap(initial);
  let bestDistance = 0;
  for (const x of xs)
    for (const y of ys) {
      const candidate = clampDockPoint({ x, y }, size, viewport);
      const area = overlap(candidate);
      const distance = (candidate.x - initial.x) ** 2 + (candidate.y - initial.y) ** 2;
      if (area < bestArea || (area === bestArea && distance < bestDistance)) {
        best = candidate;
        bestArea = area;
        bestDistance = distance;
      }
    }
  return best;
}

/** Both panel directions are bounded by the visible viewport and nearby composers. */
export function dockPanelLayout(
  point: DockPoint,
  size: DockSize,
  viewport: DockViewport,
  obstacles: readonly DockRect[],
) {
  let above = Math.max(0, point.y - viewport.y - DOCK_MARGIN - DOCK_PANEL_GAP);
  let below = Math.max(
    0,
    viewport.y + viewport.height - point.y - size.height - DOCK_MARGIN - DOCK_PANEL_GAP,
  );
  for (const rect of obstacles) {
    if (point.x >= rect.x + rect.width || point.x + size.width <= rect.x) continue;
    if (rect.y + rect.height <= point.y)
      above = Math.min(
        above,
        Math.max(0, point.y - DOCK_PANEL_GAP - rect.y - rect.height - DOCK_GAP),
      );
    if (rect.y >= point.y + size.height)
      below = Math.min(
        below,
        Math.max(0, rect.y - point.y - size.height - DOCK_PANEL_GAP - DOCK_GAP),
      );
  }
  const side = above >= 280 || above >= below ? 'above' : 'below';
  return { side, maxHeight: side === 'above' ? above : below } as const;
}
