import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { CanvasZoomControl } from './CanvasZoomControl';

it('keeps zoom actions behind the live percentage, supports exact zoom and restores focus', async () => {
  const current = { zoomBy: vi.fn(), zoomTo: vi.fn(), fitAll: vi.fn(), fitPage: vi.fn() };
  const { rerender } = render(<CanvasZoomControl canvas={{ current }} percent={37.5} />);
  const trigger = screen.getByTestId('canvas-zoom');
  expect(trigger).toHaveTextContent('37.5%');
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /zoomIn|Zoom in|放大/ }));
  expect(current.zoomBy).toHaveBeenCalledWith(1.25);
  rerender(<CanvasZoomControl canvas={{ current }} percent={46.9} />);
  expect(trigger).toHaveTextContent('46.9%');
  const field = within(dialog).getByRole('spinbutton');
  expect(field).toHaveValue(46.9);
  fireEvent.change(field, { target: { value: '72.5' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /\.apply|Apply|应用/ }));
  expect(current.zoomTo).toHaveBeenCalledWith(0.725);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});
