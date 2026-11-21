import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasSurface, type CanvasControls } from './CanvasSurface';

const pages = Array.from({ length: 7 }, (_, i) => ({
  id: String(i + 1),
  label: 'Page ' + (i + 1),
  width: 960,
  height: 540,
}));

describe('canvas selection and camera', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['mouse', 'touch'])(
    'animates from the overview to the editable page on a single %s press',
    async (pointerType) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(readonly resize: ResizeObserverCallback) {}
          observe() {
            this.resize(
              [{ contentRect: { width: 680, height: 360 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
          disconnect() {}
        },
      );
      const canvas = createRef<CanvasControls>();
      const select = vi.fn();
      const move = vi.fn();
      function Board({ pan = false }: { pan?: boolean }) {
        const [current, setCurrent] = useState('1');
        return (
          <CanvasSurface
            boardId="seven"
            currentPageId={current}
            height={540}
            width={960}
            label="slide board"
            mode={pan ? 'pan' : 'select'}
            reservedTop={76}
            reservedBottom={current === '6' ? 62 : 0}
            objects={
              current === '6'
                ? [
                    {
                      id: 'table',

                      x: 40,
                      y: 80,
                      width: 400,
                      height: 250,
                    },
                  ]
                : []
            }
            onPageChange={setCurrent}
            onSelect={select}
            onMove={move}
            ref={canvas}
            pages={pages}
          >
            <div>Selected page {current}</div>
          </CanvasSurface>
        );
      }
      const { rerender } = render(<Board />);
      const view = screen.getByRole('region', { name: 'slide board' });
      const pageScale = Number(view.dataset.scale);
      act(() => canvas.current!.fitAll());
      const overview = Number(view.dataset.scale);
      expect(overview).toBeLessThan(pageScale);
      rerender(<Board pan />);
      const sixth = screen.getByRole('button', { name: 'Page 6' });
      expect(sixth).toBeDisabled();
      fireEvent.click(sixth);
      expect(screen.getByText('Selected page 1')).toBeInTheDocument();
      rerender(<Board />);
      const center = {
        clientX: parseFloat(sixth.style.left) + parseFloat(sixth.style.width) / 2,
        clientY: parseFloat(sixth.style.top) + parseFloat(sixth.style.height) / 2,
      };
      const pointer = (target: Element, type: string) => {
        const event = new MouseEvent(type, { bubbles: true, button: 0, ...center });
        Object.assign(event, { pointerType, pointerId: 1, isPrimary: true });
        fireEvent(target, event);
      };
      pointer(sixth, 'pointerdown');
      pointer(sixth, 'pointerup');
      fireEvent.click(sixth, { detail: 1, ...center });
      expect(screen.getByText('Selected page 6')).toBeInTheDocument();
      // The destination reserves its own toolbar and fits within the available height.
      const fitted = (360 - 76 - 62 - 2 * (360 * 0.04)) / 540;
      await waitFor(() => expect(Number(view.dataset.scale)).toBeCloseTo(fitted, 4));
      const fittedSixth = Number(view.dataset.scale);
      expect(fittedSixth).toBeGreaterThan(overview * 2);
      act(() => canvas.current!.fitPage());
      expect(Number(view.dataset.scale)).toBeCloseTo(fittedSixth);
      act(() => canvas.current!.zoomTo(1.375));
      expect(Number(view.dataset.scale)).toBeCloseTo(1.375);
      fireEvent.keyDown(view, { key: 'Enter' });
      expect(Number(view.dataset.scale)).toBeCloseTo(fittedSixth);
      fireEvent.click(view);
      expect(select).toHaveBeenCalledWith();
      expect(move).not.toHaveBeenCalled();
    },
  );
});
