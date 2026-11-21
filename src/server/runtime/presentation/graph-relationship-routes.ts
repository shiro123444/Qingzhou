/** Route cross-level graph edges independently of linear process connectors.
 * Coordinates are in the renderer's unscaled 16px design units. */
type Point = { x: number; y: number };
type Box = { x: number; y: number; halfWidth: number; halfHeight: number };
export type RelationshipRoute = {
  start: Point;
  end: Point;
  label?: Box & { lines: string[] };
};

const touches = (a: Box, b: Box, gap: number) =>
  Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + gap &&
  Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight + gap;

// Slab intersection also handles horizontal/vertical segments; a label stays
// readable only if its entire ink box is clear of the connector.
function crosses(start: Point, end: Point, box: Box, gap: number) {
  let enter = 0,
    exit = 1;
  for (const [key, half] of [
    ['x', box.halfWidth],
    ['y', box.halfHeight],
  ] as const) {
    const delta = end[key] - start[key];
    const minimum = box[key] - half - gap,
      maximum = box[key] + half + gap;
    if (Math.abs(delta) < 0.001) {
      if (start[key] < minimum || start[key] > maximum) return false;
    } else {
      const a = (minimum - start[key]) / delta,
        b = (maximum - start[key]) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return false;
    }
  }
  return true;
}

export function routeGraphRelationships(
  edges: { from: string; to: string; label?: string }[],
  nodes: Map<string, Point & { lines: string[] }>,
  nodeWidth: number,
  nodeHeight: number,
  width: number,
  height: number,
  textLines: (text: string) => string[][],
  textWidth: (text: string) => number,
  transparent: boolean,
): RelationshipRoute[] {
  const inkBoxes = new Map(
    [...nodes].map(([id, p]) => [
      id,
      {
        ...p,
        halfWidth: transparent ? Math.max(...p.lines.map(textWidth)) / 2 : nodeWidth / 2,
        halfHeight: transparent ? p.lines.length * 10 + 2 : nodeHeight / 2,
      },
    ]),
  );
  const boxes = new Map(
    [...nodes].map(([id, p]) => [
      id,
      { ...p, halfWidth: nodeWidth / 2, halfHeight: nodeHeight / 2 },
    ]),
  );
  const routes: RelationshipRoute[] = edges.map((edge) => {
    const a = nodes.get(edge.from)!,
      b = nodes.get(edge.to)!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const reciprocal = edges.some((other) => other.from === edge.to && other.to === edge.from);
    const offsetX = reciprocal ? (-dy * 7) / length : 0;
    const offsetY = reciprocal ? (dx * 7) / length : 0;
    const port = (node: Box, direction: number) => {
      // A shape can receive an arrow on its border. Text-only nodes need
      // visible space around all lines, including the tip's stroke.
      const clearance = transparent ? 12 : 0;
      const tx = direction * dx,
        ty = direction * dy;
      const fraction = Math.min(
        tx === 0 ? Infinity : (node.halfWidth + clearance - Math.sign(tx) * offsetX) / Math.abs(tx),
        ty === 0
          ? Infinity
          : (node.halfHeight + clearance - Math.sign(ty) * offsetY) / Math.abs(ty),
      );
      if (fraction >= 0.5) throw new Error('Graph nodes need more space for a readable arrow');
      return { x: node.x + offsetX + tx * fraction, y: node.y + offsetY + ty * fraction };
    };
    const start = port(inkBoxes.get(edge.from)!, 1),
      end = port(inkBoxes.get(edge.to)!, -1);
    if (
      Math.hypot(end.x - start.x, end.y - start.y) < 16 ||
      [...boxes].some(
        ([id, box]) => id !== edge.from && id !== edge.to && crosses(start, end, box, 6),
      )
    )
      throw new Error('Graph connector crosses another node; separate relationship lanes');
    return { start, end };
  });
  for (const [index, edge] of edges.entries()) {
    if (!edge.label) continue;
    const route = routes[index],
      { start, end } = route;
    const dx = end.x - start.x,
      dy = end.y - start.y,
      length = Math.hypot(dx, dy);
    const nx = -dy / length,
      ny = dx / length;
    const outside = ((start.x + end.x) / 2 - width / 2) * nx > 0 ? 1 : -1;
    let found: RelationshipRoute['label'];
    for (const lines of textLines(edge.label)) {
      const halfWidth = Math.max(...lines.map(textWidth)) / 2,
        halfHeight = lines.length * 10;
      const offset = Math.abs(nx) * halfWidth + Math.abs(ny) * halfHeight + 7;
      for (const t of [0.5, 0.35, 0.65, 0.22, 0.78]) {
        for (const sign of [outside, -outside]) {
          const box = {
            x: start.x + dx * t + sign * nx * offset,
            y: start.y + dy * t + sign * ny * offset,
            halfWidth,
            halfHeight,
            lines,
          };
          if (
            box.x < halfWidth ||
            box.x > width - halfWidth ||
            box.y < halfHeight ||
            box.y > height - halfHeight ||
            [...boxes.values()].some((node) => touches(box, node, 12)) ||
            routes.some(
              (other) =>
                (other.label && touches(box, other.label, 8)) ||
                crosses(other.start, other.end, box, 4),
            )
          )
            continue;
          found = box;
          break;
        }
        if (found) break;
      }
      if (found) break;
    }
    if (!found)
      throw new Error('Graph relationship labels need more space clear of all nodes and arrows');
    route.label = found;
  }
  return routes;
}
