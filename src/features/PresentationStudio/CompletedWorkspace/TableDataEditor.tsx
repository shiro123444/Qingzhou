import { Input } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DataEditorModal } from './DataEditorModal';

export interface EditableTable {
  id: string;
  title?: string;
  columns: string[];
  rows: string[][];
}

const styles = createStaticStyles(({ css, cssVar }) => ({
  scroll: css`
    overflow: auto;
    max-height: 55dvh;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    table {
      width: 100%;
      border-collapse: collapse;
    }
    td,
    th {
      min-width: 128px;
      padding: 4px;
      border: 1px solid ${cssVar.colorBorderSecondary};
    }
    thead {
      position: sticky;
      z-index: 1;
      top: 0;
      background: var(--qz-glass-strong, ${cssVar.colorBgContainer});
      backdrop-filter:var(--qz-glass-filter);
    }
    thead input {
      font-weight: 600;
    }
  `,
}));

export function TableDataEditor({
  table,
  onCancel,
  onSave,
  failureMessage,
}: {
  table: EditableTable;
  onCancel: () => void;
  onSave: (data: Pick<EditableTable, 'columns' | 'rows'>, requestId: string) => Promise<boolean>;
  failureMessage?: string;
}) {
  const { t } = useTranslation('common');
  const [cells, setCells] = useState(() => [table.columns, ...table.rows]);
  const valid = cells[0].every((v) => v.trim());
  const changed = cells.some((row, i) =>
    row.some((v, j) => v !== (i === 0 ? table.columns : table.rows[i - 1])[j]),
  );
  const rowInputs = (row: string[], i: number, saving: boolean) =>
    row.map((v, j) => {
      const Cell = i === 0 ? 'th' : 'td';
      const label =
        i === 0
          ? t('presentationCanvas.tableHeader', { column: j + 1 })
          : t('presentationCanvas.tableCell', { row: i, column: j + 1 });
      return (
        <Cell key={j} scope={i === 0 ? 'col' : undefined}>
          <Input
            aria-label={label}
            aria-invalid={i === 0 && !v.trim() ? true : undefined}
            disabled={saving}
            maxLength={i === 0 ? 40 : 240}
            value={v}
            onChange={(event) => {
              const next = event.target.value;
              setCells((current) =>
                current.map((line, r) =>
                  r === i ? line.map((cell, c) => (c === j ? next : cell)) : line,
                ),
              );
            }}
          />
        </Cell>
      );
    });
  return (
    <DataEditorModal
      canSave={valid && changed}
      draft={cells}
      failureMessage={failureMessage}
      title={table.title || t('presentationCanvas.editTableData')}
      width={760}
      onCancel={onCancel}
      onSave={(id) => onSave({ columns: cells[0], rows: cells.slice(1) }, id)}
    >
      {(saving) => (
        <div className={styles.scroll}>
          <table aria-label={t('presentationCanvas.editTableData')}>
            <thead>
              <tr>{rowInputs(cells[0], 0, saving)}</tr>
            </thead>
            <tbody>
              {cells.slice(1).map((row, i) => (
                <tr key={i}>{rowInputs(row, i + 1, saving)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DataEditorModal>
  );
}
