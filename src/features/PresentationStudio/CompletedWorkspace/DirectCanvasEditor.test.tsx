import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { annotationElements } from '../../../../packages/utils/src/presentationAnnotation';
import * as slideReader from '../annotation/readEditableSlide';
import { DirectCanvasEditor, useDirectCanvasEdit } from './DirectCanvasEditor';

it('keeps the insertion point and unsubmitted text while another gesture is being published', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text x="8" y="20">Original</text></svg>';
  const local: slideReader.EditableSlide = {
    slide: { svg, order: 6, slideId: 'six' },
    hash: 'original',
    versionId: 'v1',
    boxes: [{ index: 0, x: 0, y: 0, width: 0.5, height: 0.5, kind: 'text' }],
    elements: annotationElements(svg),
  };
  const read = vi
    .spyOn(slideReader, 'readEditableSlide')
    .mockImplementation(() => new Promise(() => {}));
  try {
    function Canvas({ version }: { version: string }) {
      const edit = useDirectCanvasEdit('job', 6, version, true, [], () => {}, [], local);
      return (
        <>
          <button onDoubleClick={() => edit.hit({ x: 0.2, y: 0.2 }, true)}>Title</button>
          {edit.editing && edit.field && edit.data && (
            <DirectCanvasEditor
              editing
              close={edit.close}
              data={edit.data}
              field={edit.field}
              page={6}
              send={vi.fn()}
            />
          )}
        </>
      );
    }
    const { rerender } = render(<Canvas version="v1" />);
    fireEvent.doubleClick(screen.getByRole('button'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '正在编辑第六页' } });
    input.setSelectionRange(2, 4);
    rerender(<Canvas version="v2" />);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input.value).toBe('正在编辑第六页');
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
  } finally {
    read.mockRestore();
  }
});
