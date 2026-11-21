import { z } from 'zod';

import { measureSlideText, slideTextTokens } from './text-measurement';

/** Explicit cells are reusable content, not a picture of a table. */
export const reportTableSchema = z
  .object({
    type: z.literal('table'),
    columns: z.array(z.string().trim().min(1).max(40)).min(2).max(6),
    rows: z
      .array(z.array(z.string().max(240)).min(2).max(6))
      .min(1)
      .max(12),
    fixedGrid: z
      .object({
        widths: z.array(z.number().finite().positive()).min(2).max(6),
        heights: z.array(z.number().finite().positive()).min(2).max(13),
        verticalPadding: z.number().finite().min(0).max(24),
      })
      .strict()
      .optional(),
    columnWeights: z.array(z.number().positive()).min(2).max(6).optional(),
    fontSize: z.number().min(18).max(24).default(20),
    fontFamily: z.string().min(1).max(200).optional(),
    headerText: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .optional(),
    bodyFill: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .optional(),
    bandFill: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .optional(),
    textColor: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .optional(),
    headerFill: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .default('#1D3E6B'),
  })
  .strict();

export type ReportTable = z.infer<typeof reportTableSchema>;
export const reportTableAppearance = (table: ReportTable) => ({
  bandFill: table.bandFill ?? '#F1F5F9',
  bodyFill: table.bodyFill ?? '#FFFFFF',
  bodyText: table.textColor ?? '#1A1A1A',
  fontFamily: table.fontFamily ?? 'Microsoft YaHei, Arial',
  headerFill: table.headerFill,
  headerText: table.headerText ?? '#FFFFFF',
  rule: '#CBD5E1',
});
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function layoutReportTable(table: ReportTable, width: number, availableHeight?: number) {
  if (
    table.rows.some((row) => row.length !== table.columns.length) ||
    (table.columnWeights && table.columnWeights.length !== table.columns.length)
  )
    throw new Error('Table rows and column weights must match all column headers');
  const cells = [table.columns, ...table.rows];
  const { fontFamily } = reportTableAppearance(table);
  const measure = (value: string, row: number) =>
    measureSlideText(value, table.fontSize, fontFamily, row ? 'normal' : 'bold');
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const boundaryCache = new Map<string, Set<number>>();
  const wordBoundaries = (value: string) => {
    let boundaries = boundaryCache.get(value);
    if (!boundaries) {
      boundaries = new Set([...segmenter.segment(value)].map((part) => part.index));
      boundaries.add(value.length);
      boundaryCache.set(value, boundaries);
    }
    return boundaries;
  };
  const wrap = (cell: string, colWidth: number, row: number): string[] => {
    const result: string[] = [];
    // Explicit paragraph boundaries are content and must survive balancing.
    for (const paragraph of cell.split('\n')) {
      // Header whitespace separates a human label from a variable/unit. Honor
      // that boundary before orphan balancing splits the label to accompany R.
      const words = paragraph.trim().split(/\s+/u);
      if (
        row === 0 &&
        words.length > 1 &&
        measure(paragraph, row) > colWidth - 24 &&
        words.every((word) => measure(word, row) <= colWidth - 24 + 0.01)
      ) {
        let line = '';
        for (const word of words) {
          const joined = line ? `${line} ${word}` : word;
          if (line && measure(joined, row) > colWidth - 24 + 0.01) {
            result.push(line);
            line = word;
          } else line = joined;
        }
        if (line) result.push(line);
        continue;
      }
      const parts = slideTextTokens(paragraph);
      const boundaries = wordBoundaries(paragraph);
      const offsets = [0];
      for (const part of parts) offsets.push(offsets.at(-1)! + part.length);
      if (parts.some((part) => measure(part, row) > colWidth - 24 + 0.01))
        throw new Error('Table column needs more width for an unbroken label');
      const costs = Array.from({ length: parts.length + 1 }, () => Infinity);
      const next = Array.from({ length: parts.length }, () => 0);
      costs[parts.length] = 0;
      for (let i = parts.length - 1; i >= 0; i--) {
        let line = '';
        for (let j = i; j < parts.length; j++) {
          line += parts[j];
          const used = measure(line, row);
          if (used > colWidth - 24 + 0.01) break;
          const last = j === parts.length - 1;
          const orphan = last && i > 0 && [...line.trim()].length < 3;
          const punctuation =
            /^[，。！？；：、）》】」』]/u.test(parts[i]) || /[（《【「『]$/u.test(parts[j]);
          const cost =
            100 +
            (orphan ? 2000 : 0) +
            (punctuation ? 4000 : 0) +
            // Prefer word boundaries at the same readable line count. Words
            // wider than a slot can still wrap without shrinking typography.
            (!last && !boundaries.has(offsets[j + 1]) ? 24 : 0) +
            // A table cell is a compact label: balance the final line too,
            // instead of filling the first line and leaving a short fragment.
            ((colWidth - 24 - used) / Math.max(1, colWidth - 24)) ** 2 * 12 +
            costs[j + 1];
          if (cost < costs[i]) {
            costs[i] = cost;
            next[i] = j + 1;
          }
        }
      }
      if (!parts.length) result.push('');
      else
        for (let i = 0; i < parts.length; i = next[i]) {
          if (!next[i]) throw new Error('Table column needs more width for an unbroken label');
          result.push(parts.slice(i, next[i]).join(''));
        }
    }
    return result;
  };
  // A direct cell edit preserves the previously published grid. The presentation
  // compiler still measures a different slot or grid with its normal adaptive layout.
  const grid = table.fixedGrid;
  if (
    grid &&
    grid.widths.length === table.columns.length &&
    grid.heights.length === cells.length &&
    Math.abs(grid.widths.reduce((sum, value) => sum + value, 0) - width) <= 0.1
  ) {
    const { widths, heights, verticalPadding } = grid;
    const rows = cells.map((row, i) =>
      row.map((cell, j) => {
        const lines = wrap(cell, widths[j], i);
        if (lines.length * table.fontSize * 1.3 + verticalPadding > heights[i] + 0.1)
          throw new Error(`第 ${i + 1} 行第 ${j + 1} 列的文字超出原有单元格，请缩短文字`);
        return lines;
      }),
    );
    return {
      rows,
      widths,
      heights,
      verticalPadding,
      height: heights.reduce((sum, value) => sum + value, 0),
    };
  }
  const weights = table.columnWeights ?? table.columns.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const prior = weights.map((weight) => (width * weight) / total);
  const ideal = table.columns.map((_, col) =>
    Math.max(
      ...cells.map(
        (row, i) => Math.max(...row[col].split('\n').map((part) => measure(part, i))) + 24,
      ),
    ),
  );
  const minimum = table.columns.map((_, col) =>
    Math.max(
      table.fontSize * 2 + 24,
      ...table.columns[col]
        .split(/\s+/u)
        .filter((word) => /\s/u.test(table.columns[col]) && /^\p{Script=Han}{1,3}$/u.test(word))
        .map((word) => measure(word, 0) + 24),
      ...cells.map(
        (row, i) =>
          Math.max(
            0,
            ...slideTextTokens(row[col])
              .filter((t) => t !== '\n')
              .map((t) => measure(t, i)),
          ) + 24,
      ),
    ),
  );
  const minimumTotal = minimum.reduce((a, b) => a + b, 0);
  if (minimumTotal > width) throw new Error('Table column needs more width for an unbroken label');
  // Weights are soft priors. First fund real cell demand; never reserve a large
  // index column while forcing a sentence in the adjacent column to orphan.
  const idealTotal = ideal.reduce((a, b) => a + b, 0);
  let widths =
    idealTotal <= width
      ? ideal.map((value, i) => value + ((width - idealTotal) * weights[i]) / total)
      : minimum.map(
          (value, i) =>
            value +
            ((width - minimumTotal) * Math.sqrt(Math.max(1, ideal[i] - value))) /
              minimum.reduce((sum, m, j) => sum + Math.sqrt(Math.max(1, ideal[j] - m)), 0),
        );
  const cache = new Map<string, string[][]>();
  const column = (col: number, w: number) => {
    const key = `${col}:${w.toFixed(4)}`;
    let value = cache.get(key);
    if (!value) {
      value = cells.map((row, i) => wrap(row[col], w, i));
      cache.set(key, value);
    }
    return value;
  };
  const score = (candidate: number[]) => {
    const columns = candidate.map((w, col) => column(col, w));
    return (
      cells.reduce(
        (sum, _, row) => sum + Math.max(...columns.map((col) => col[row].length)) * 100,
        0,
      ) +
      columns.reduce(
        (sum, col, colIndex) =>
          sum +
          col.reduce(
            (n, lines, row) =>
              n +
              (lines.length > 1 &&
              [...lines.at(-1)!.trim()].length < 3 &&
              !(
                row === 0 &&
                /\s/u.test(cells[0][colIndex]) &&
                cells[0][colIndex].trim().split(/\s+/u).includes(lines.at(-1)!.trim())
              )
                ? 1000
                : 0),
            0,
          ),
        0,
      ) +
      candidate.reduce((sum, w, i) => sum + Math.abs(w - prior[i]) / width, 0)
    );
  };
  if (idealTotal > width) {
    let best = score(widths);
    const step = Math.max(4, width / 80);
    for (let iteration = 0; iteration < 40; iteration++) {
      let improved: number[] | undefined;
      for (let from = 0; from < widths.length; from++)
        for (let to = 0; to < widths.length; to++) {
          if (from === to || widths[from] - step < minimum[from]) continue;
          const candidate = [...widths];
          candidate[from] -= step;
          candidate[to] += step;
          const cost = score(candidate);
          if (cost < best - 0.0001) {
            best = cost;
            improved = candidate;
          }
        }
      if (!improved) break;
      widths = improved;
    }
  }
  const columns = widths.map((w, col) => column(col, w));
  const rows = cells.map((_, row) => columns.map((col) => col[row]));
  const textHeights = rows.map(
    (row) => Math.max(...row.map((cell) => cell.length)) * table.fontSize * 1.3,
  );
  const verticalPadding =
    availableHeight === undefined
      ? 24
      : Math.min(
          24,
          Math.max(12, (availableHeight - textHeights.reduce((a, b) => a + b, 0)) / rows.length),
        );
  const heights = textHeights.map((height) => height + verticalPadding);
  return { rows, widths, heights, verticalPadding, height: heights.reduce((a, b) => a + b, 0) };
}

export function renderReportTable(table: ReportTable, width: number, height: number): string {
  const layout = layoutReportTable(table, width, height);
  const paint = reportTableAppearance(table);
  if (
    layout.rows.some((row) =>
      row.some(
        (cell) => cell.length > 1 && /^\p{Script=Han}[，。！？；：、]?$/u.test(cell.at(-1)!.trim()),
      ),
    )
  )
    throw new Error(
      'Table requires more column width to avoid a one-character orphan; reallocate columns or enlarge the evidence region, never shrink text or remove facts.',
    );
  if (layout.height > height + 0.1)
    throw new Error(
      `Table requires ${Math.ceil(layout.height)}px height; available ${height}px. Shorten cells or allocate more space; do not drop rows or shrink text.`,
    );
  const result: string[] = [];
  let y = 0;
  layout.rows.forEach((row, rowIndex) => {
    const h = layout.heights[rowIndex];
    result.push(
      `<rect x="0" y="${y}" width="${width}" height="${h}" fill="${rowIndex === 0 ? paint.headerFill : rowIndex % 2 ? paint.bodyFill : paint.bandFill}"/>`,
    );
    let x = 0;
    row.forEach((lines, col) => {
      lines.forEach((line, i) =>
        result.push(
          `<text x="${x + 12}" y="${y + layout.verticalPadding / 2 + table.fontSize + i * table.fontSize * 1.3}" font-family="${escape(paint.fontFamily)}" font-size="${table.fontSize}" font-weight="${rowIndex ? 'normal' : 'bold'}" fill="${rowIndex ? paint.bodyText : paint.headerText}">${escape(line)}</text>`,
        ),
      );
      x += layout.widths[col];
    });
    y += h;
    result.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${paint.rule}" stroke-width="1"/>`,
    );
  });
  return `<g data-report-table="true">${result.join('')}</g>`;
}
