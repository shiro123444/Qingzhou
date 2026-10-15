import { z } from 'zod';

import { measureSlideText } from './text-measurement';

/** Explicit cells are reusable content, not a picture of a table. */
export const reportTableSchema = z
  .object({
    type: z.literal('table'),
    columns: z.array(z.string().trim().min(1).max(40)).min(2).max(6),
    rows: z
      .array(z.array(z.string().max(240)).min(2).max(6))
      .min(1)
      .max(12),
    columnWeights: z.array(z.number().positive()).min(2).max(6).optional(),
    fontSize: z.number().min(18).max(24).default(20),
    headerFill: z
      .string()
      .regex(/^#[a-f\d]{6}$/iu)
      .default('#1D3E6B'),
  })
  .strict();

export type ReportTable = z.infer<typeof reportTableSchema>;
const family = 'Microsoft YaHei, Arial';
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
  const weights = table.columnWeights ?? table.columns.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((weight) => (width * weight) / total);
  const rows = [table.columns, ...table.rows].map((row, rowIndex) =>
    row.map((cell, col) => {
      const lines: string[] = [];
      let line = '';
      for (const token of cell.match(/[A-Za-z0-9.%+-]+|\n|./gu) ?? []) {
        const measured = (value: string) =>
          measureSlideText(value, table.fontSize, family, rowIndex ? 'normal' : 'bold');
        if (measured(token) > widths[col] - 24)
          throw new Error('Table column needs more width for an unbroken label');
        if (token === '\n' || (line && measured(line + token) > widths[col] - 24)) {
          lines.push(line);
          line = '';
        }
        if (token !== '\n') line += token;
      }
      if (line || !lines.length) lines.push(line);
      return lines;
    }),
  );
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
  if (layout.height > height + 0.1)
    throw new Error(
      `Table requires ${Math.ceil(layout.height)}px height; available ${height}px. Shorten cells or allocate more space; do not drop rows or shrink text.`,
    );
  const result: string[] = [];
  let y = 0;
  layout.rows.forEach((row, rowIndex) => {
    const h = layout.heights[rowIndex];
    result.push(
      `<rect x="0" y="${y}" width="${width}" height="${h}" fill="${rowIndex === 0 ? table.headerFill : rowIndex % 2 ? '#FFFFFF' : '#F1F5F9'}"/>`,
    );
    let x = 0;
    row.forEach((lines, col) => {
      lines.forEach((line, i) =>
        result.push(
          `<text x="${x + 12}" y="${y + layout.verticalPadding / 2 + table.fontSize + i * table.fontSize * 1.3}" font-family="${family}" font-size="${table.fontSize}" font-weight="${rowIndex ? 'normal' : 'bold'}" fill="${rowIndex ? '#1A1A1A' : '#FFFFFF'}">${escape(line)}</text>`,
        ),
      );
      x += layout.widths[col];
    });
    y += h;
    result.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#CBD5E1" stroke-width="1"/>`,
    );
  });
  return `<g data-report-table="true">${result.join('')}</g>`;
}
