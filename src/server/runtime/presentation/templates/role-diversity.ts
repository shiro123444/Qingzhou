/** Bounded catalogs must retain late-page data/closing roles, not just their first entries. */
export function selectRoleDiverse<T extends { roles: readonly string[] }>(
  items: readonly T[],
  limit: number,
): T[] {
  const remaining = [...items];
  const result: T[] = [];
  const covered = new Set<string>();
  while (remaining.length && result.length < limit) {
    let best = 0;
    let score = -1;
    remaining.forEach((item, index) => {
      const novelty = item.roles.filter((role) => !covered.has(role)).length;
      if (novelty > score) {
        best = index;
        score = novelty;
      }
    });
    const [selected] = remaining.splice(best, 1);
    selected.roles.forEach((role) => covered.add(role));
    result.push(selected);
  }
  return result;
}
