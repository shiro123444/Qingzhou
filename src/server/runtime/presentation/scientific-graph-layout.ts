/** Deterministic readable DAG layout. Model coordinates are ordering/orientation hints, not pixel positions. */
export interface ScientificGraphSpec {
  edges: Array<{ from: string; to: string; label?: string }>;
  nodes: Array<{ id: string; label: string; x: number; y: number }>;
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
  const lines = wrapGraphLabel(text, width);
  if (lines.length > 2)
    throw new Error(
      `Graph label "${text}" needs ${minimumGraphLabelWidth(text)}px at full size; enlarge the diagram or move the explanation into the body, never shrink the font`,
    );
  return lines;
}
export function layoutScientificGraph(spec: ScientificGraphSpec, width: number, height: number) {
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
  const layers = Math.max(...rank.values()) + 1;
  const across = spec.edges.reduce((sum, e) => {
    const a = spec.nodes.find((n) => n.id === e.from)!,
      b = spec.nodes.find((n) => n.id === e.to)!;
    return sum + Math.abs(a.x - b.x) - Math.abs(a.y - b.y);
  }, 0);
  // Gap and node width come from the real two-line wrap, not half the string width.
  // An unbreakable token can make the second line longer than the average half.
  const minimumGap = Math.max(
    32,
    ...spec.edges.map((edge) => (edge.label ? minimumGraphLabelWidth(edge.label) + 20 : 32)),
  );
  const minimumNodeWidth = Math.max(
    84,
    ...spec.nodes.map((node) => minimumGraphLabelWidth(node.label) + 20),
  );
  const readableWidth = Math.ceil(layers * minimumNodeWidth + Math.max(0, layers - 1) * minimumGap);
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
  const nodeHeight = 48;
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
    if (acyclic && horizontal && height - 36 < peers.length * nodeHeight + (peers.length - 1) * 8)
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
  return { positions, nodeWidth, nodeHeight, horizontal };
}
