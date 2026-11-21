import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useRuntimeStore } from '@/store/runtime';

import Sidebar from './index';

describe('RuntimeWorkspace Sidebar (C-112-05)', () => {
  it('renders runs and allows collapsing and expanding with 44x44px keyboard-accessible trigger', () => {
    // Setup mock run in runtime store
    useRuntimeStore.setState({
      activeRunId: 'run-1',
      runs: {
        'run-1': {
          createdAt: '2026-09-03T02:00:00.000Z',
          runId: 'run-1',
          sessionId: 'session-1',
          state: 'running',
          updatedAt: '2026-09-03T02:00:00.000Z',
        },
      },
    });

    const onCollapsedChange = vi.fn();
    render(<Sidebar onCollapsedChange={onCollapsedChange} />);

    // Initially expanded
    const sidebar = screen.getByTestId('workspace-sidebar');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText(/Runs \(1\)/)).toBeInTheDocument();

    // Collapse button is present with accessible label
    const collapseBtn = screen.getByTestId('workspace-sidebar-collapse-btn');
    expect(collapseBtn).toBeInTheDocument();
    expect(collapseBtn).toHaveAttribute('aria-label', '收起侧栏');

    collapseBtn.focus();
    fireEvent.click(collapseBtn);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');

    // Expanded runs header is hidden
    expect(screen.queryByText(/Runs \(1\)/)).not.toBeInTheDocument();

    // 44x44px expand button is present on narrow edge, keyboard reachable with aria-label
    const expandBtn = screen.getByTestId('workspace-sidebar-expand-btn');
    expect(expandBtn).toBe(collapseBtn);
    expect(expandBtn).toHaveFocus();
    expect(expandBtn).toHaveAttribute('aria-label', '展开侧栏');
    expect(expandBtn).toHaveAttribute('tabIndex', '0');

    // Keyboard action (Enter) or click restores sidebar
    fireEvent.keyDown(expandBtn, { key: 'Enter' });
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText(/Runs \(1\)/)).toBeInTheDocument();
  });
});
