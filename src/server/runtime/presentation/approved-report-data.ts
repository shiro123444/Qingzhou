/** Table and chart content share a legacy visual kind. Cell and header structure
 * identifies a native table even when its author calls it a schedule or roster. */
export const describesReportTable = (text: string) =>
  /表格|清单|单元格|表头|行头|列头|列名|\btables?\b|\brows?\b|\bcells?\b|\bcolumn headers?\b/iu.test(
    text,
  ) ||
  /(?:^|[：:，,、。；;\s]|可编辑)(?:排班|指标|时间|对照|明细|登记)表(?:$|[：:，,、。；;\s])/u.test(
    text,
  );

/** Read repeated, explicitly labelled numeric rows from the approved outline. */
export function readApprovedReportRows(points: string[]) {
  const records = points.flatMap((point) => {
    const row = /^([^：:]+)[：:]([^：:]+)$/u.exec(point);
    if (!row) return [];
    const cells = row[2]
      .split(/[，,]/u)
      .map((cell) => /^([^\d+-]+)([-+]?\d+(?:\.\d+)?%?)$/u.exec(cell.trim()));
    if (
      !row[1].trim() ||
      row[1].trim().length > 240 ||
      cells.length < 2 ||
      cells.some((cell) => !cell || !cell[1].trim() || cell[1].trim().length > 40)
    )
      return [];
    return [
      {
        source: point,
        labels: cells.map((cell) => cell![1].trim()),
        row: [row[1].trim(), ...cells.map((cell) => cell![2])],
      },
    ];
  });
  if (
    records.length < 2 ||
    records.length > 12 ||
    records[0].labels.length > 5 ||
    !records.every(({ labels }) => JSON.stringify(labels) === JSON.stringify(records[0].labels))
  )
    return undefined;
  return records;
}

export function approvedReportColumns(
  records: NonNullable<ReturnType<typeof readApprovedReportRows>>,
) {
  const groupLabel = records.every(({ row }) => row[0].startsWith('条件')) ? '条件' : '项目';
  return [groupLabel, ...records[0].labels];
}
