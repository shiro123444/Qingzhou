const number = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
const numericLists = () => new RegExp(`${number}(?:\\s*[、,，]\\s*${number})+`, 'giu');

/** Only explicit paired numeric lists with a correspondence cue are evidence.
 * Ambiguous prose, unrelated lists and fitted functions are never guessed. */
export function approvedPointSeries(content: readonly string[]): [number, number][] | undefined {
  return approvedPointSeriesSource(content)?.points;
}

export function approvedPointSeriesSource(content: readonly string[]) {
  const candidates = [];
  for (const [index, point] of content.entries()) {
    const lists = [...point.matchAll(numericLists())];
    if (lists.length !== 2) continue;
    const between = point.slice(lists[0].index! + lists[0][0].length, lists[1].index!);
    if (!/对应|分别|correspond|respectively|paired/iu.test(between)) continue;
    const [x, y] = lists.map((list) =>
      [...list[0].matchAll(new RegExp(number, 'giu'))].map((m) => Number(m[0])),
    );
    if (x.length !== y.length || x.length > 300 || [...x, ...y].some((v) => !Number.isFinite(v)))
      continue;
    candidates.push({
      index,
      lists,
      points: x.map((value, i): [number, number] => [value, y[i]]),
    });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function updateApprovedPointSeries(
  content: string[],
  previous: [number, number][][],
  series: [number, number][][],
) {
  const source = approvedPointSeriesSource(content);
  if (!source) return content;
  const matches = previous.flatMap((points, index) =>
    points.length === source.points.length &&
    points.every(([x, y], i) => source.points[i][0] === x && source.points[i][1] === y)
      ? [index]
      : [],
  );
  if (matches.length !== 1) return content;
  const points = series[matches[0]];
  const value = content[source.index];
  const [x, y] = source.lists;
  const delimiter = (list: string) => /\s*[、,，]\s*/u.exec(list)?.[0] ?? '、';
  const xStart = x.index!;
  const yStart = y.index!;
  const next =
    value.slice(0, xStart) +
    points.map(([v]) => v).join(delimiter(x[0])) +
    value.slice(xStart + x[0].length, yStart) +
    points.map(([, v]) => v).join(delimiter(y[0])) +
    value.slice(yStart + y[0].length);
  return content.map((point, index) => (index === source.index ? next : point));
}

/** Follow a narrated axis or first difference only when its original values and
 * the named axis match. Unlabelled lists can describe unrelated measurements. */
export function updateChartNarration(
  text: string,
  previous: [number, number][][],
  next: [number, number][][],
  labels: [string, string],
) {
  const axisNames = labels.map((label) =>
    [label, ...label.split(/[\s（()）/]+/u)]
      .filter((token) => token.length > 1)
      .map((token) => token.toLowerCase()),
  );
  const deltas = (points: [number, number][]) =>
    points.slice(1).map((point, i) => Number((point[1] - points[i][1]).toPrecision(14)));
  return text.replace(numericLists(), (raw: string, index: number) => {
    const prefix =
      text
        .slice(0, index)
        .split(/[。；;，、,\n]/u)
        .at(-1)
        ?.toLowerCase() ?? '';
    const delta = /增量|差值|差分|相邻差|increments?|differences?|deltas?/iu.test(prefix);
    const axis = delta
      ? 1
      : axisNames.findIndex((names) => names.some((name) => prefix.includes(name)));
    if (axis < 0) return raw;
    const values = [...raw.matchAll(new RegExp(number, 'giu'))].map((match) => Number(match[0]));
    const replacements = previous.flatMap((points, seriesIndex) => {
      const oldValues = delta ? deltas(points) : points.map((point) => point[axis]);
      if (oldValues.length !== values.length || !values.every((value, i) => value === oldValues[i]))
        return [];
      const newValues = delta
        ? deltas(next[seriesIndex])
        : next[seriesIndex].map((point) => point[axis]);
      if (values.length === newValues.length && newValues.every((v, i) => values[i] === v))
        return [raw];
      return [newValues.join(/\s*[、,，]\s*/u.exec(raw)?.[0] ?? '、')];
    });
    return new Set(replacements).size === 1 ? replacements[0] : raw;
  });
}
