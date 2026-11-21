import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import zh from '../../../../locales/zh-CN/common.json';
import { TableDataEditor } from './TableDataEditor';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh', keySeparator: false, resources: { zh: { common: zh } } });
});
describe('editing an existing native table', () => {
  it('keeps row and column counts, preserves the draft on failure, and reuses only an identical request', async () => {
    const onSave = vi.fn().mockResolvedValue(false),
      onCancel = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <TableDataEditor
          table={{
            id: 'visual-1',
            title: '夜读指标',
            columns: ['指标', '记录'],
            rows: [['到馆人次', '入口登记']],
          }}
          onSave={onSave}
          onCancel={onCancel}
          failureMessage="这一格的文字超过原有行高"
        />
      </I18nextProvider>,
    );
    const apply = screen.getByRole('button', { name: /应\s*用/ });
    expect(apply).toBeDisabled();
    const header = screen.getByRole('textbox', { name: '第 2 列标题' });
    fireEvent.change(header, { target: { value: ' ' } });
    expect(apply).toBeDisabled();
    fireEvent.change(header, { target: { value: '记录方式' } });
    const cell = screen.getByRole('textbox', { name: '第 1 行第 2 列' });
    fireEvent.change(cell, { target: { value: '入口签到' } });
    fireEvent.click(apply);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('这一格的文字超过原有行高');
    expect(onSave.mock.calls[0][0]).toEqual({
      columns: ['指标', '记录方式'],
      rows: [['到馆人次', '入口签到']],
    });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await screen.findByRole('alert');
    expect(onSave.mock.calls[1][1]).toBe(onSave.mock.calls[0][1]);
    fireEvent.change(cell, { target: { value: '入口点数' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    onSave.mockResolvedValueOnce(true);
    fireEvent.click(apply);
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[2][1]).not.toBe(onSave.mock.calls[0][1]);
  });
});
