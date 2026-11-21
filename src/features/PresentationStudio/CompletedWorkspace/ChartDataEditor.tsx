import { Button, Input, Tabs } from 'antd';
import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresentationMessageInput } from '../../../../packages/runtime-contracts/src';

import { DataEditorModal } from './DataEditorModal';

export interface EditableChart {
  exportFormat?: 'chart' | 'shapes';
  id: string;
  series: { label: string; points: [number, number][] }[];
  title: string;
  xLabel: string;
  yLabel: string;
}

type ChartRows = string[][][];
type ChartNumbers = NonNullable<PresentationMessageInput['chartDataPatch']>['series'];
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

export function ChartDataEditor({
  chart,
  onCancel,
  onSave,
}: {
  chart: EditableChart;
  onCancel: () => void;
  onSave: (series: ChartNumbers, requestId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation('common');
  const [rows, setRows] = useState<ChartRows>(() =>
    chart.series.map(({ points }) => points.map(([x, y]) => [String(x), String(y)])),
  );
  const valid = rows.every((series) =>
    series.every((row) =>
      row.every((value) => decimal.test(value.trim()) && Number.isFinite(Number(value))),
    ),
  );
  const unchanged = rows.every(
    (series, i) =>
      series.length === chart.series[i].points.length &&
      series.every(
        ([x, y], j) =>
          Number(x) === chart.series[i].points[j][0] && Number(y) === chart.series[i].points[j][1],
      ),
  );
  const updateSeries = (index: number, update: (points: string[][]) => string[][]) => {
    setRows((current) => current.map((points, i) => (i === index ? update(points) : points)));
  };
  return (
    <DataEditorModal
      title={chart.title}
      draft={rows}
      canSave={valid && !unchanged}
      onCancel={onCancel}
      onSave={(id) =>
        onSave(
          rows.map((points) => points.map(([x, y]) => [Number(x), Number(y)])),
          id,
        )
      }
    >
      {(saving) => (
        <>
          {chart.exportFormat && (
            <p>
              {t(
                chart.exportFormat === 'chart'
                  ? 'presentationCanvas.downloadChart'
                  : 'presentationCanvas.downloadShapes',
              )}
            </p>
          )}
          <Tabs
            items={chart.series.map(({ label }, i) => ({
              key: String(i),
              label,
              children: (
                <div style={{ maxHeight: 320, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderSpacing: 6 }}>
                    <thead>
                      <tr>
                        <th scope="col">{chart.xLabel}</th>
                        <th scope="col">{chart.yLabel}</th>
                        <td />
                      </tr>
                    </thead>
                    <tbody>
                      {rows[i].map((row, j) => (
                        <tr key={j}>
                          {row.map((value, k) => (
                            <td key={k}>
                              <Input
                                aria-label={`${k === 0 ? chart.xLabel : chart.yLabel} ${j + 1}`}
                                disabled={saving}
                                inputMode="decimal"
                                value={value}
                                onChange={(event) => {
                                  const next = event.target.value;
                                  updateSeries(i, (points) =>
                                    points.map((point, index) =>
                                      index === j
                                        ? point.map((cell, axis) => (axis === k ? next : cell))
                                        : point,
                                    ),
                                  );
                                }}
                              />
                            </td>
                          ))}
                          <td>
                            <Button
                              aria-label={t('presentationCanvas.deletePoint', { number: j + 1 })}
                              disabled={saving || rows[i].length <= 2}
                              icon={<Minus size={15} />}
                              type="text"
                              onClick={() =>
                                updateSeries(i, (points) => points.filter((_, n) => n !== j))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Button
                    disabled={saving || rows[i].length >= 300}
                    icon={<Plus size={15} />}
                    type="text"
                    onClick={() => updateSeries(i, (points) => [...points, ['', '']])}
                  >
                    {t('presentationCanvas.addPoint')}
                  </Button>
                </div>
              ),
            }))}
          />
          {!valid && <p role="alert">{t('presentationCanvas.inputError')}</p>}
        </>
      )}
    </DataEditorModal>
  );
}
