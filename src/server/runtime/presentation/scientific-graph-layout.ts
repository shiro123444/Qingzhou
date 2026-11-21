import { type RelationshipRoute, routeGraphRelationships } from './graph-relationship-routes';
import { measureSlideText } from './text-measurement';

/** Deterministic readable DAG layout. Model coordinates are ordering/orientation hints, not pixel positions. */
export interface ScientificGraphSpec {
  edges: Array<{ from: string; to: string; label?: string; bidirectional?: boolean }>;
  nodes: Array<{ id: string; label: string; x: number; y: number }>;
  style?: { nodeFill?: string; nodeStroke?: string; fontFamily?: string };
}
const textWidth = (text: string) =>
  [...text].reduce((sum, ch) => sum + (/\P{ASCII}/u.test(ch) ? 16 : 9), 0);
const labelTokens = (text: string) =>
  text.match(/O\([^)]*\)|[A-Za-z0-9.+-]+|\P{ASCII}|\s+|./gu) ?? [];
/** Wrap at full size. Latin identifiers stay intact; the font never shrinks. */
function wrapGraphLabel(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const token of labelTokens(text)) {
    if (textWidth(token) > width)
      throw new Error(`Graph label "${text}" needs a wider node for "${token}"`);
    if (line && textWidth(line + token) > width) {
      lines.push(line.trim());
      line = '';
    }
    line += token;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
/** Smallest width whose wrap stays within maxLines, never below an unbreakable token. */
export function minimumGraphLabelWidth(text: string, maxLines = 2): number {
  const tokens = labelTokens(text);
  let lo = Math.max(1, ...tokens.map(textWidth));
  let hi = Math.max(lo, textWidth(text));
  const readable = (width: number) => {
    const lines = wrapGraphLabel(text, width);
    const last = lines.at(-1) ?? '';
    // A one-character last line is an orphan, not a readable wrap.
    return lines.length <= maxLines && (lines.length < 2 || [...last].length > 1);
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (readable(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
export function graphLabelLines(text: string, width: number): string[] {
  const parts = text.match(/^(.+?[·•])(.+)$/u);
  // A compound label carries the entity and its qualification. Keep the
  // qualification intact when both phrases fit on separate native text lines.
  const lines =
    parts && textWidth(text) > width && parts.slice(1).every((part) => textWidth(part) <= width)
      ? parts.slice(1)
      : wrapGraphLabel(text, width);
  if (lines.length === 2 && [...lines[1]].length === 1) {
    const previous = labelTokens(lines[0]);
    const moved = previous.pop();
    if (moved && previous.length && textWidth(moved + lines[1]) <= width) {
      lines[0] = previous.join('');
      lines[1] = moved + lines[1];
    }
  }
  if (lines.length > 2)
    throw new Error(
      `Graph label "${text}" needs ${minimumGraphLabelWidth(text)}px at full size; enlarge the diagram or move the explanation into the body, never shrink the font`,
    );
  return lines;
}

/** A complete ordered chain with additional backward edges is a workflow with
 * feedback, not a failed DAG. Retain every relationship in separate return lanes. */
export function scientificGraphFeedbackOrder(spec: ScientificGraphSpec) {
  const orders = [
    [...spec.nodes].sort((a, b) => a.x - b.x || a.y - b.y),
    spec.nodes,
    [...spec.nodes].sort((a, b) => a.y - b.y || a.x - b.x),
  ];
  for (const nodes of orders) {
    if (
      nodes.length < 2 ||
      !nodes
        .slice(1)
        .every((node, i) =>
          spec.edges.some((edge) => edge.from === nodes[i].id && edge.to === node.id),
        )
    )
      continue;
    const indices = new Map(nodes.map((node, i) => [node.id, i]));
    const feedback = spec.edges.flatMap((edge, i) =>
      indices.get(edge.from)! > indices.get(edge.to)! ? [i] : [],
    );
    if (feedback.length) return { nodes, feedback };
  }
}

export function layoutScientificGraph(
  spec: ScientificGraphSpec,
  width: number,
  height: number,
): {
  positions: Map<string, { x: number; y: number; lines: string[] }>;
  nodeWidth: number;
  nodeHeight: number;
  horizontal: boolean;
  feedbackLanes: Map<number, number>;
  relationshipRoutes?: RelationshipRoute[];
} {
  const feedback = scientificGraphFeedbackOrder(spec);
  const order = new Map(feedback?.nodes.map((node, index) => [node.id, index]));
  const crossLevelFeedback = Boolean(
    feedback && spec.edges.some((edge) => order.get(edge.to)! - order.get(edge.from)! > 1),
  );
  if (feedback && !crossLevelFeedback) {
    const forward = {
      ...spec,
      nodes: feedback.nodes,
      edges: spec.edges.filter((_, i) => !feedback.feedback.includes(i)),
    };
    const rowHeight = height - feedback.feedback.length * 64;
    if (rowHeight < 64)
      throw new Error('Graph feedback lanes need more height; retain every return relationship');
    const layout = layoutScientificGraph(forward, width, rowHeight);
    if (!layout.horizontal)
      throw new Error('Graph feedback workflow needs a wider horizontal evidence slot');
    const feedbackLanes = new Map(
      feedback.feedback.map((index, lane) => [index, rowHeight + 16 + lane * 64]),
    );
    return { ...layout, feedbackLanes };
  }
  const incoming = new Map(spec.nodes.map((n) => [n.id, 0]));
  const rank = new Map(spec.nodes.map((n) => [n.id, 0]));
  for (const edge of spec.edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const queue = spec.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const edge of spec.edges.filter((e) => e.from === id)) {
      rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
      incoming.set(edge.to, incoming.get(edge.to)! - 1);
      if (incoming.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const acyclic = visited === spec.nodes.length;
  if (crossLevelFeedback) for (const [id, index] of order) rank.set(id, index);
  const layers = Math.max(...rank.values()) + 1;
  const across = spec.edges.reduce((sum, e) => {
    const a = spec.nodes.find((n) => n.id === e.from)!,
      b = spec.nodes.find((n) => n.id === e.to)!;
    return sum + Math.abs(a.x - b.x) - Math.abs(a.y - b.y);
  }, 0);
  // Gap and node width come from the real two-line wrap, not half the string width.
  // An unbreakable token can make the second line longer than the average half.
  const clear = spec.style?.nodeFill === 'none' && spec.style?.nodeStroke === 'none';
  const minimumGap = Math.max(
    32,
    // One extra unit protects measured wraps from subpixel gap arithmetic.
    ...spec.edges.map((edge) =>
      edge.label ? minimumGraphLabelWidth(edge.label) + (clear ? 21 : 20) : 32,
    ),
  );
  const minimumNodeWidth = Math.max(
    clear ? 52 : 84,
    ...spec.nodes.map((node) => minimumGraphLabelWidth(node.label) + (clear ? 21 : 20)),
  );
  const readableWidth = Math.ceil(layers * minimumNodeWidth + Math.max(0, layers - 1) * minimumGap);
  const crossLevel =
    crossLevelFeedback ||
    (acyclic && spec.edges.some((edge) => rank.get(edge.to)! - rank.get(edge.from)! > 1));
  if (crossLevel) {
    const nodeWidth = Math.min(
      164,
      Math.max(minimumNodeWidth, ...spec.nodes.map((n) => textWidth(n.label) + 20)),
    );
    const nodeHeight = clear ? 40 : 48;
    const padding = 12;
    const topPadding = crossLevelFeedback ? 24 : padding;
    if (height < 2 * nodeHeight + 64 || width < 2 * nodeWidth + 48)
      throw new Error(
        'Graph relationship topology needs more height and width for separate node and label lanes',
      );
    const xs = spec.nodes.map((n) => n.x),
      ys = spec.nodes.map((n) => n.y);
    const left = Math.min(...xs),
      top = Math.min(...ys),
      spanX = Math.max(...xs) - left,
      spanY = Math.max(...ys) - top;
    const positions = new Map(
      spec.nodes.map((node) => {
        const normalizedX =
          spanX > 0.12 ? (node.x - left) / spanX : rank.get(node.id)! / Math.max(1, layers - 1);
        // If supplied hints are collinear, stagger intermediate ranks so a
        // shortcut cannot run straight through the intervening process node.
        const normalizedY = spanY > 0.12 ? (node.y - top) / spanY : rank.get(node.id)! % 2;
        return [
          node.id,
          {
            x: padding + nodeWidth / 2 + normalizedX * (width - 2 * padding - nodeWidth),
            y:
              topPadding +
              nodeHeight / 2 +
              normalizedY * (height - padding - topPadding - nodeHeight),
            lines: graphLabelLines(node.label, nodeWidth - 20),
          },
        ];
      }),
    );
    const placed = [...positions.values()];
    if (
      placed.some((a, i) =>
        placed
          .slice(i + 1)
          .some((b) => Math.abs(a.x - b.x) < nodeWidth + 8 && Math.abs(a.y - b.y) < nodeHeight + 8),
      )
    )
      throw new Error('Graph relationship nodes need more separation');
    const relationshipRoutes = routeGraphRelationships(
      spec.edges,
      positions,
      nodeWidth,
      nodeHeight,
      width,
      height,
      (text) => [[text], graphLabelLines(text, minimumGraphLabelWidth(text))],
      (line) => Math.max(textWidth(line), measureSlideText(line, 16, spec.style?.fontFamily)),
      clear,
    );
    return {
      positions,
      nodeWidth,
      nodeHeight,
      horizontal: false,
      feedbackLanes: new Map(),
      relationshipRoutes,
    };
  }
  const horizontalFits = width >= readableWidth;
  const horizontal =
    acyclic && (across >= 0 || height < layers * 48 + (layers - 1) * 36 + 36) && horizontalFits;
  const nodeWidth =
    acyclic && horizontal
      ? Math.min(Math.max(156, minimumNodeWidth), (width - (layers - 1) * minimumGap) / layers)
      : Math.max(minimumNodeWidth, Math.min(156, width / 3));
  if (nodeWidth > width)
    throw new Error(
      `Graph needs at least ${readableWidth}px width for readable labels at full size`,
    );
  const nodeHeight = clear ? 40 : 48;
  const padding = clear ? 16 : 36;
  if (acyclic && !horizontal && height < layers * nodeHeight + (layers - 1) * 36 + 36)
    throw new Error(
      `Graph needs at least ${Math.ceil(layers * minimumNodeWidth + (layers - 1) * minimumGap)}px width for readable horizontal branches, or ${layers * nodeHeight + (layers - 1) * 36 + 36}px height for vertical layers`,
    );
  const positions = new Map<string, { x: number; y: number; lines: string[] }>();
  for (const node of spec.nodes) {
    const peers = spec.nodes
      .filter((n) => rank.get(n.id) === rank.get(node.id))
      .sort((a, b) => (horizontal ? a.y - b.y : a.x - b.x));
    const index = peers.findIndex((n) => n.id === node.id);
    if (
      acyclic &&
      horizontal &&
      height - padding < peers.length * nodeHeight + (peers.length - 1) * 8
    )
      throw new Error(
        `Graph layer needs ${peers.length * nodeHeight + (peers.length - 1) * 8 + 36}px height; branches must not overlap`,
      );
    if (acyclic && !horizontal && width < peers.length * nodeWidth + (peers.length - 1) * 16)
      throw new Error('Graph branches need more width; use a full-width diagram or fewer nodes');
    const x = acyclic
      ? horizontal
        ? nodeWidth / 2 +
          (layers === 1
            ? (width - nodeWidth) / 2
            : (rank.get(node.id)! * (width - nodeWidth)) / (layers - 1))
        : peers.length === 1
          ? width / 2
          : nodeWidth / 2 + (index * (width - nodeWidth)) / (peers.length - 1)
      : nodeWidth / 2 + node.x * (width - nodeWidth);
    const y = acyclic
      ? horizontal
        ? peers.length === 1
          ? (height - 20) / 2
          : 8 + nodeHeight / 2 + (index * (height - 36 - nodeHeight)) / (peers.length - 1)
        : 8 +
          nodeHeight / 2 +
          (layers === 1
            ? (height - 36 - nodeHeight) / 2
            : (rank.get(node.id)! * (height - 36 - nodeHeight)) / (layers - 1))
      : 32 + node.y * (height - 100);
    positions.set(node.id, { x, y, lines: graphLabelLines(node.label, nodeWidth - 20) });
  }
  const placed = [...positions.values()];
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      if (
        Math.abs(placed[i].x - placed[j].x) < nodeWidth + 4 &&
        Math.abs(placed[i].y - placed[j].y) < nodeHeight + 4
      )
        throw new Error('Graph nodes overlap; allocate more space');
  if (horizontal)
    for (const edge of spec.edges) {
      if (!edge.label) continue;
      const gap = positions.get(edge.to)!.x - positions.get(edge.from)!.x - nodeWidth;
      if (gap + 0.5 < minimumGraphLabelWidth(edge.label) + 20)
        throw new Error(
          `Graph needs at least ${readableWidth}px width so edge label "${edge.label}" stays readable at full size`,
        );
    }
  return { positions, nodeWidth, nodeHeight, horizontal, feedbackLanes: new Map<number, number>() };
}
