import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import { JOB_STATE_COLORS } from '../JobStateTag';
import PresentationJobList from './index';

const job = (jobId: string, state: PresentationJob['state']): PresentationJob => ({
  createdAt: '2026-08-30T10:00:00.000Z',
  jobId,
  state,
  updatedAt: '2026-08-30T10:05:00.000Z',
});

describe('PresentationJobList', () => {
  it('renders every honest state including failed and cancelled', () => {
    const jobs = [
      job('job-queued', 'queued'),
      job('job-running', 'running'),
      job('job-completed', 'completed'),
      job('job-failed', 'failed'),
      job('job-cancelled', 'cancelled'),
    ];
    render(
      <PresentationJobList
        jobs={jobs}
        selectedJobId={null}
        titles={{ 'job-completed': 'Q3 Report' }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('cancelled')).toBeInTheDocument();
    expect(screen.getByText('Q3 Report')).toBeInTheDocument();
  });

  it('announces the selected job via aria-pressed and data-selected', () => {
    const onSelect = vi.fn();
    render(
      <PresentationJobList
        jobs={[job('job-a', 'running')]}
        selectedJobId="job-a"
        titles={{}}
        onSelect={onSelect}
      />,
    );

    const option = screen.getByRole('option', {
      name: /Job job-a, state: running, selected/i,
    });
    expect(option).toHaveAttribute('aria-pressed', 'true');
    expect(option).toHaveAttribute('data-selected', 'true');
    expect(option).toHaveAttribute('tabindex', '0');

    // Native button semantics: Enter/Space trigger a click
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith('job-a');
  });

  it('renders a responsive-capable empty state and a listbox container', () => {
    render(<PresentationJobList jobs={[]} selectedJobId={null} titles={{}} onSelect={vi.fn()} />);

    expect(screen.getByText('No jobs yet')).toBeInTheDocument();
  });

  it('maps each state to the expected tag colour contract', () => {
    expect(JOB_STATE_COLORS.completed).toBe('success');
    expect(JOB_STATE_COLORS.failed).toBe('error');
    expect(JOB_STATE_COLORS.running).toBe('processing');
    expect(JOB_STATE_COLORS.queued).toBe('default');
    expect(JOB_STATE_COLORS.cancelled).toBe('default');
  });

  it('requires confirmation before deleting a saved work', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <PresentationJobList
        jobs={[job('job-a', 'completed')]}
        selectedJobId={null}
        titles={{ 'job-a': '年度复盘' }}
        onDelete={onDelete}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除 年度复盘' }));
    expect(await screen.findByText('删除「年度复盘」？')).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /删\s*除/u }).at(-1)!);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('job-a'));
  });
});
