import type { CanvasRect } from '../../../packages/runtime-contracts/src/canvas';

export const alignmentEdges = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const;
export type AlignmentEdge = (typeof alignmentEdges)[number];

export function selectionBounds(items: CanvasRect[]): CanvasRect {
  const x = Math.min(...items.map((item) => item.x));
  const y = Math.min(...items.map((item) => item.y));
  return {
    x,
    y,
    width: Math.max(...items.map((item) => item.x + item.width)) - x,
    height: Math.max(...items.map((item) => item.y + item.height)) - y,
  };
}
export function alignSelection(items: (CanvasRect & { id: string })[], edge: AlignmentEdge) {
  const bounds = selectionBounds(items);
  return items.map((item) => {
    let dx = 0,
      dy = 0;
    switch (edge) {
      case 'left':
        dx = bounds.x - item.x;
        break;
      case 'right':
        dx = bounds.x + bounds.width - item.x - item.width;
        break;
      case 'center':
        dx = bounds.x + (bounds.width - item.width) / 2 - item.x;
        break;
      case 'top':
        dy = bounds.y - item.y;
        break;
      case 'bottom':
        dy = bounds.y + bounds.height - item.y - item.height;
        break;
      case 'middle':
        dy = bounds.y + (bounds.height - item.height) / 2 - item.y;
        break;
    }
    return { object: item.id, dx, dy };
  });
}

/** Keep the first and last items fixed and equalize the space between adjacent edges. */
export function distributeSelection(items: (CanvasRect & { id: string })[], vertical: boolean) {
  const axis = vertical ? 'y' : 'x',
    extent = vertical ? 'height' : 'width';
  const sorted = [...items].sort(
    (a, b) => a[axis] + a[extent] / 2 - (b[axis] + b[extent] / 2) || a[axis] - b[axis],
  );
  if (sorted.length < 3) return [];
  const first = sorted[0],
    last = sorted[sorted.length - 1];
  const gap =
    (last[axis] + last[extent] - first[axis] - sorted.reduce((sum, r) => sum + r[extent], 0)) /
    (sorted.length - 1);
  let next = first[axis];
  return sorted.map((r) => {
    const offset = next - r[axis];
    next += r[extent] + gap;
    return { object: r.id, dx: vertical ? 0 : offset, dy: vertical ? offset : 0 };
  });
}

export function snapAxis(start: number, length: number, guides: number[], tolerance: number) {
  let distance = Infinity,
    guide: number | undefined,
    delta = 0;
  for (const edge of [start, start + length / 2, start + length]) {
    for (const target of guides) {
      const diff = target - edge;
      if (Math.abs(diff) <= tolerance && Math.abs(diff) < distance) {
        distance = Math.abs(diff);
        guide = target;
        delta = diff;
      }
    }
  }
  return { delta, guide };
}
