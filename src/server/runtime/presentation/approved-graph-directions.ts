import { semanticBlockSchema } from './semantic-blocks';

const pairOperator = /↔|⟷|⇄|⇆|<[-=]>/gu;
const normalize = (s: string) => s.trim().toLowerCase();

/** A single connector with two arrowheads preserves an explicitly reciprocal
 * relation without turning a labelled process into two independent events. */
export function bindApprovedGraphDirections(rawBlocks: unknown, approved?: readonly string[]) {
  if (!Array.isArray(rawBlocks) || !approved?.length) return rawBlocks;
  const clauses = approved
    .flatMap((point) => (typeof point === 'string' ? point.split(/[，。；;\n]/u) : []))
    .filter(
      (clause) =>
        /↔|⟷|⇄|⇆|<[-=]>|双向/u.test(clause) &&
        !/不是|并非|禁止|不应|不要|不可|不得|不使用|不允许|取消|排除|避免|没有|不成立|\b(?:no|not|never|without)\b/iu.test(
          clause,
        ),
    );
  if (!clauses.length) return rawBlocks;
  const blocks = rawBlocks.map((block) => {
    if (block?.kind !== 'scientific-diagram' || block.spec?.type !== 'graph') return block;
    const result = semanticBlockSchema.safeParse(block);
    if (
      !result.success ||
      result.data.kind !== 'scientific-diagram' ||
      result.data.spec.type !== 'graph'
    )
      return block;
    const { nodes, edges } = result.data.spec;
    const aliases = nodes.flatMap((node) => {
      const role = node.label.split(/[·•（(：:|｜—]/u)[0];
      return [...new Set([node.label, role, node.id].map(normalize))]
        .filter(Boolean)
        .map((label) => ({ id: node.id, label }));
    });
    const endpoint = (raw: string, left: boolean) => {
      const text = normalize(raw).replace(left ? /[」】”"'\s]+$/u : /^[「【“"'\s]+/u, '');
      const matching = aliases
        .filter(({ label }) => {
          if (!(left ? text.endsWith(label) : text.startsWith(label))) return false;
          if (!/[a-z\d_]$/iu.test(left ? label.at(0)! : label.at(-1)!)) return true;
          const neighbour = left
            ? text.slice(0, -label.length).at(-1)
            : text.slice(label.length).at(0);
          return !neighbour || !/[a-z\d_]/iu.test(neighbour);
        })
        .sort((a, b) => b.label.length - a.label.length);
      const longest = matching.filter((item) => item.label.length === matching[0]?.label.length);
      return new Set(longest.map(({ id }) => id)).size === 1 ? longest[0]?.id : undefined;
    };
    const pairs = clauses.flatMap((clause) => {
      const sources = [...clause.matchAll(pairOperator)].map((match) => [
        clause.slice(0, match.index),
        clause.slice(match.index! + match[0].length),
      ]);
      // For written Chinese, both named endpoints must directly qualify the
      // explicit two-way relation in the same clause.
      for (const match of clause.matchAll(
        /(?:与|和)([^，。；;与和]+?)(?:之间)?(?:为|采用|使用|建立|保持|进行|用)?双向/gu,
      )) {
        const right = normalize(match[1]).replace(/[「」【】“”"']/gu, '');
        if (aliases.some((alias) => alias.label === right))
          sources.push([clause.slice(0, match.index), right]);
      }
      return sources.flatMap(([left, right]) => {
        const a = endpoint(left, true),
          b = endpoint(right, false);
        return a && b && a !== b ? [[a, b]] : [];
      });
    });
    let changed = false;
    const grounded = edges.map((edge) => {
      if (
        edge.bidirectional ||
        edges.some((other) => other.from === edge.to && other.to === edge.from) ||
        !pairs.some(
          ([a, b]) => (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
        )
      )
        return edge;
      changed = true;
      return { ...edge, bidirectional: true };
    });
    return changed ? { ...block, spec: { ...block.spec, edges: grounded } } : block;
  });
  return blocks.some((block, index) => block !== rawBlocks[index]) ? blocks : rawBlocks;
}
