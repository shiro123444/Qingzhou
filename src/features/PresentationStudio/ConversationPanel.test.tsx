import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src';
import { ConversationPanel } from './ConversationPanel';

const job: PresentationJob = {
  createdAt: '2026-09-04T12:00:00Z',
  jobId: 'page-edit',
  slideCount: 8,
  state: 'completed',
  updatedAt: '2026-09-04T12:00:00Z',
  versionId: 'v1',
};

describe('slide edit scope', () => {
  it('keeps a draft on page six across navigation and retries the same operation after a network error', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(true);
    const panel = (page: number) => (
      <ConversationPanel
        inline
        job={job}
        selectedPage={page}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onSend={onSend}
      />
    );
    const { rerender } = render(panel(1));
    const scope = screen.getByTestId('presentation-conversation-scope');
    const input = screen.getByTestId('presentation-conversation-input');
    rerender(panel(6));
    expect(scope).toHaveValue('6');
    fireEvent.change(input, { target: { value: '缩短本页标题' } });
    rerender(panel(7));
    expect(scope).toHaveValue('6');
    fireEvent.click(screen.getByTestId('presentation-conversation-send'));
    await screen.findByRole('alert');
    expect(input).toHaveValue('缩短本页标题');
    expect(onSend).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('presentation-conversation-send')).not.toHaveClass(
        'ant-btn-loading',
      ),
    );
    fireEvent.click(screen.getByTestId('presentation-conversation-send'));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[0]).toEqual(onSend.mock.calls[1]);
    expect(onSend.mock.calls[1][1]).toMatchObject({ target: { type: 'slide', slideNumber: 6 } });
    expect(scope).toHaveValue('7');
  });

  it('requires explicit deck selection for each deck-wide edit', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(
      <ConversationPanel
        inline
        job={job}
        selectedPage={6}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onSend={onSend}
      />,
    );
    const scope = screen.getByTestId('presentation-conversation-scope');
    fireEvent.change(scope, { target: { value: 'deck' } });
    const input = screen.getByTestId('presentation-conversation-input');
    fireEvent.change(input, { target: { value: '统一全稿标题' } });
    fireEvent.click(screen.getByTestId('presentation-conversation-send'));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onSend.mock.calls[0][1].target).toEqual({ type: 'deck' });
    expect(scope).toHaveValue('6');
  });
});
