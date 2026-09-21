import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StudioNotice } from './StudioNotice';

describe('StudioNotice', () => {
  it('counts down then dismisses without occupying layout flow', async () => {
    const onClose = vi.fn();
    render(
      <div style={{ height: 200, position: 'relative' }}>
        <StudioNotice
          durationMs={40}
          testId="presentation-export-notice"
          title="PPTX 已就绪"
          tone="success"
          onClose={onClose}
        />
      </div>,
    );
    const notice = screen.getByTestId('presentation-export-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('presentation-export-notice-countdown')).toHaveTextContent('1');
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('keeps error notices keyboard-dismissible before the countdown ends', () => {
    const onClose = vi.fn();
    render(
      <StudioNotice
        testId="presentation-export-error"
        title="导出失败"
        tone="error"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
