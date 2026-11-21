import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import zh from '../../../../locales/zh-CN/common.json';
import * as geometry from './geometry';
import { SlideAnnotation } from './SlideAnnotation';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'zh', keySeparator: false, resources: { zh: { common: zh } } });
});
afterEach(() => vi.restoreAllMocks());
const text = {
  index: 0,
  x: 0.1,
  y: 0.1,
  width: 0.3,
  height: 0.12,
  label: '标题',
  kind: 'text',
} as const;
const image = {
  index: 1,
  x: 0.5,
  y: 0.4,
  width: 0.4,
  height: 0.4,
  label: '封面原图',
  kind: 'image',
} as const;
async function setup(boxes: geometry.ElementBox[] = [text, image], table = false, editable = true) {
  const editData = vi.fn();
  const contentBlocks = table
    ? [
        {
          id: 'counts',
          kind: 'scientific-diagram',
          spec: { type: 'table', columns: ['指标', '方式'], rows: [['到馆', '签到']] },
        },
      ]
    : [];
  const svg =
    '<svg viewBox="0 0 960 540">' +
    boxes
      .map((b) =>
        table && b.index === 0
          ? `<g data-scientific-diagram="counts"><text>${b.label}</text></g>`
          : `<text>${b.label}</text>`,
      )
      .join('') +
    '</svg>';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        versionId: 'v1',
        slide: { slideId: 'slide-2', svg, metadata: { contentBlocks } },
      }),
      {
        status: 200,
      },
    ),
  );
  vi.spyOn(geometry, 'measureAnnotationElements').mockReturnValue(boxes);
  const send = vi.fn().mockResolvedValue(false),
    close = vi.fn();
  const dock = document.createElement('div');
  render(
    <>
      <div
        ref={(node) => {
          if (node && !node.contains(dock)) node.append(dock);
        }}
      />
      <I18nextProvider i18n={i18n}>
        <SlideAnnotation
          dock={dock}
          jobId="job"
          page={2}
          versionId="v1"
          getDataEditor={(target) =>
            editable && target.blockId === 'counts' ? editData : undefined
          }
          onClose={close}
          onSend={send}
        />
      </I18nextProvider>
    </>,
  );
  await screen.findByText('点选或框住要修改的元素');
  const overlay = screen.getByRole('application');
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(80, 60, 480, 270));
  const point = (
    type: string,
    x: number,
    y: number,
    id = 1,
    primary = true,
    pointerType = 'mouse',
  ) => {
    const e = new MouseEvent(type, {
      clientX: 80 + x * 480,
      clientY: 60 + y * 270,
      bubbles: true,
      button: 0,
    });
    Object.assign(e, { pointerId: id, isPrimary: primary, pointerType });
    fireEvent(overlay, e);
  };
  return { send, close, overlay, point, dock, editData };
}
describe('precise page annotation', () => {
  it('submits exactly the highlighted source index and reuses its request id when retrying', async () => {
    const { send, close, overlay, point, dock } = await setup();
    point('pointerdown', 0.2, 0.16);
    point('pointerup', 0.2, 0.16);
    expect(screen.getByRole('status')).toHaveTextContent('已选 1 个元素 · 标题');
    expect(overlay.querySelectorAll('[data-annotation-element]')).toHaveLength(1);
    expect(dock).toContainElement(screen.getByRole('textbox'));
    const input = screen.getByLabelText('局部修改意见');
    fireEvent.change(input, { target: { value: '标题改成自然创作' } });
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false);
    fireEvent.submit(input.closest('form')!);
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByLabelText('发送标注'));
    await screen.findByText('未能发送，请重试或重新标注');
    expect(close).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatchObject({
      content: '标题改成自然创作',
      target: { type: 'slide', slideNumber: 2 },
      annotation: {
        slideId: 'slide-2',
        expectedVersionId: 'v1',
        elementIndices: [0],
        baseSvgHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    send.mockResolvedValueOnce(true);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(send.mock.calls[1][1].requestId).toBe(send.mock.calls[0][1].requestId);
  });

  it('keeps a comment and its selection when touch is interrupted, then permits keyboard re-selection without sending', async () => {
    const { send, point, overlay } = await setup();
    point('pointerdown', 0.05, 0.02, 7, true, 'touch');
    point('pointermove', 0.45, 0.3, 7, true, 'touch');
    expect(screen.getByRole('status')).toHaveTextContent('已选 1 个元素 · 标题');
    expect(overlay.querySelector('[data-annotation-element="0"]')).toBeInTheDocument();
    point('pointerup', 0.45, 0.3, 7, true, 'touch');
    expect(screen.getByRole('status')).toHaveTextContent('标题');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留这段标注' } });
    point('pointerdown', 0.52, 0.44, 2, true, 'touch');
    point('pointerdown', 0.63, 0.62, 5, false, 'touch');
    point('pointerup', 0.9, 0.9, 2, true, 'touch');
    expect(screen.getByRole('status')).toHaveTextContent('标题');
    point('pointerdown', 0.5, 0.5);
    point('pointercancel', 0.6, 0.6);
    expect(screen.getByRole('status')).toHaveTextContent('标题');
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }));
    expect(screen.getByRole('textbox')).toHaveValue('保留这段标注');
    fireEvent.keyDown(overlay, { key: 'ArrowLeft' });
    expect(screen.getByRole('status')).toHaveTextContent('封面原图');
    expect(overlay.querySelector('[data-annotation-element="1"]')).toBeInTheDocument();
    fireEvent.keyDown(overlay, { key: 'Enter' });
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
  });

  it('routes a table child to its data editor and blocks mixed visual edits', async () => {
    const { point, send, editData } = await setup([text, image], true);
    point('pointerdown', 0.2, 0.16);
    point('pointerup', 0.2, 0.16);
    expect(screen.getByRole('status')).toHaveTextContent('已选表格内 1 个元素');
    fireEvent.click(screen.getByRole('button', { name: '编辑表格数据' }));
    expect(editData).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('发送标注')).not.toBeInTheDocument();
    point('pointerdown', 0, 0);
    point('pointerup', 1, 1);
    expect(screen.getByRole('status')).toHaveTextContent('重新单独选择表格、图表或普通元素');
    expect(screen.queryByRole('button', { name: '编辑表格数据' })).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('explains a table with missing native evidence without exposing an edit', async () => {
    const { point } = await setup([text, image], true, false);
    point('pointerdown', 0.2, 0.16);
    point('pointerup', 0.2, 0.16);
    expect(screen.getByRole('status')).toHaveTextContent('当前版本没有可编辑的数据');
    expect(screen.queryByLabelText('发送标注')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑表格数据' })).not.toBeInTheDocument();
  });

  it('shows the server limit before submitting an oversized selection', async () => {
    const boxes = Array.from({ length: 41 }, (_, index) => ({ ...text, index }));
    const { point, send } = await setup(boxes);
    point('pointerdown', 0, 0);
    point('pointerup', 1, 1);
    expect(screen.getByRole('alert')).toHaveTextContent('已选 41 个元素');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '整体改变' } });
    const button = screen.getByRole('button', { name: '发送标注' });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(send).not.toHaveBeenCalled();
  });
});
