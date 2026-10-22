import '@testing-library/jest-dom/vitest';

import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentationTrialClient, TrialRequestError } from '@/services/runtime/trialClient';
import type { TrialExecution } from '@/types/presentationTrial';

import TrialLaunch from './TrialLaunch';

const render = (ui: ReactElement) =>
  testingRender(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
const budget = {
  maxProbes: 1,
  maxRenders: 2,
  maxEvaluations: 1,
  maxTokens: 48000,
  maxCostMicros: 2000000,
  maxDurationMs: 180000,
};
const execution: TrialExecution = {
  executionId: 'task',
  requestId: 'request',
  source: { jobId: 'source', versionId: 'v1', slideId: 's1' },
  state: 'running',
  phase: 'probe',
  startedAt: '2026-10-21',
  updatedAt: '2026-10-21',
};
const props = {
  jobId: 'source',
  versionId: 'v1',
  slideId: 's1',
  visible: true,
  onCompleted: vi.fn(),
};
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(presentationTrialClient, 'status').mockResolvedValue({ budget });
  vi.spyOn(presentationTrialClient, 'start').mockResolvedValue({ budget, execution });
  vi.spyOn(presentationTrialClient, 'cancel').mockResolvedValue({
    budget,
    execution: { ...execution, state: 'cancelled' },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  props.onCompleted.mockClear();
});
async function ready() {
  const button = await screen.findByRole('button', { name: 'Confirm and start one trial' });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}
describe('workspace page trial launch', () => {
  it('shows the server budget and starts only after explicit confirmation', async () => {
    render(<TrialLaunch {...props} />);
    const button = await ready();
    expect(screen.getByText(/48000 tokens.*180 seconds/)).toBeInTheDocument();
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(presentationTrialClient.start).toHaveBeenCalledOnce());
    expect(presentationTrialClient.start).toHaveBeenCalledWith({
      jobId: 'source',
      expectedVersionId: 'v1',
      slideId: 's1',
      requestId: expect.any(String),
      confirmed: true,
    });
  });
  it('recovers a running trial after refresh without starting another one', async () => {
    vi.mocked(presentationTrialClient.status).mockResolvedValue({ budget, execution });
    render(<TrialLaunch {...props} />);
    await screen.findByText('Generating one candidate…');
    expect(screen.getByRole('button', { name: 'Confirm and start one trial' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel trial' })).toBeEnabled();
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
  it('cancels a recovered job and shows the terminal result', async () => {
    vi.mocked(presentationTrialClient.status).mockResolvedValue({ budget, execution });
    render(<TrialLaunch {...props} />);
    const cancel = await screen.findByRole('button', { name: 'Cancel trial' });
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget,
      execution: { ...execution, state: 'cancelled' },
    });
    fireEvent.click(cancel);
    await screen.findByText('Trial cancelled. The original is preserved.');
    expect(presentationTrialClient.cancel).toHaveBeenCalledWith('task');
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
  it('opens completed evidence once without selecting or applying a candidate', async () => {
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget,
      execution: { ...execution, state: 'completed', runId: 'run' },
    });
    render(<TrialLaunch {...props} />);
    await waitFor(() => expect(props.onCompleted).toHaveBeenCalledWith('run'));
    expect(props.onCompleted).toHaveBeenCalledOnce();
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
  it('keeps an uncertain request identity across unmount and retry', async () => {
    vi.mocked(presentationTrialClient.start).mockRejectedValue(new Error('Disconnected'));
    const first = render(<TrialLaunch {...props} />);
    fireEvent.click(await ready());
    await screen.findByText(
      'The request could not be completed. You can retry with the same choice.',
    );
    const id = vi.mocked(presentationTrialClient.start).mock.calls[0][0].requestId;
    first.unmount();
    render(<TrialLaunch {...props} />);
    fireEvent.click(await ready());
    await waitFor(() => expect(presentationTrialClient.start).toHaveBeenCalledTimes(2));
    expect(vi.mocked(presentationTrialClient.start).mock.calls[1][0].requestId).toBe(id);
  });
  it('keeps source conflict errors visible while status refreshes', async () => {
    vi.mocked(presentationTrialClient.start).mockRejectedValue(
      new TrialRequestError('PRESENTATION_CONFLICT', 409),
    );
    render(<TrialLaunch {...props} />);
    fireEvent.click(await ready());
    await screen.findByText(
      'The source has changed or is being edited. Refresh and compare the latest version.',
    );
    await waitFor(() => expect(presentationTrialClient.status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('The source has changed');
  });
  it.each(['budget-exceeded', 'deadline-exceeded', 'interrupted'] as const)(
    'shows %s without automatically restarting',
    async (state) => {
      vi.mocked(presentationTrialClient.status).mockResolvedValue({
        budget,
        execution: { ...execution, state },
      });
      render(<TrialLaunch {...props} />);
      await ready();
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(presentationTrialClient.start).not.toHaveBeenCalled();
    },
  );
  it('disables paid work when the runtime has not supplied a policy', async () => {
    vi.mocked(presentationTrialClient.status).mockRejectedValue(
      new TrialRequestError('PRESENTATION_NOT_FOUND', 404),
    );
    render(<TrialLaunch {...props} />);
    await screen.findByText('Page trials are unavailable in this runtime.');
    expect(screen.getByRole('button', { name: 'Confirm and start one trial' })).toBeDisabled();
  });
  it('refreshes experiences for failed trials as well as completed comparisons', async () => {
    const onLearningRecorded = vi.fn();
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget,
      execution: {
        ...execution,
        state: 'failed',
        learningStatus: 'recorded',
        learningEpisodeId: 'episode',
      },
    });
    render(<TrialLaunch {...props} onLearningRecorded={onLearningRecorded} />);
    await waitFor(() => expect(onLearningRecorded).toHaveBeenCalledWith('episode'));
    expect(props.onCompleted).not.toHaveBeenCalled();
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
  it('retries pending experience archiving without restarting the trial', async () => {
    const onLearningRecorded = vi.fn();
    vi.mocked(presentationTrialClient.status)
      .mockResolvedValueOnce({
        budget,
        execution: { ...execution, state: 'failed', learningStatus: 'pending' },
      })
      .mockResolvedValue({
        budget,
        execution: {
          ...execution,
          state: 'failed',
          learningStatus: 'recorded',
          learningEpisodeId: 'episode',
        },
      });
    render(<TrialLaunch {...props} onLearningRecorded={onLearningRecorded} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry experience archiving' }));
    await waitFor(() => expect(onLearningRecorded).toHaveBeenCalledWith('episode'));
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
});

describe('serial trial opt-in', () => {
  const serialBudget = {
    ...budget,
    maxTokens: 96000,
    maxDurationMs: 360000,
    maxRenders: 5,
    maxProbes: 2,
    maxEvaluations: 2,
  };
  it('requires explicit opt-in and shows the shared budget before starting both rounds', async () => {
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget,
      singleBudget: budget,
      serialBudget,
    });
    render(<TrialLaunch {...props} />);
    await ready();
    const checkbox = screen.getByRole('checkbox', {
      name: 'Try one serial refinement (two rounds total)',
    });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    await ready();
    expect(
      screen.getByText(/Two rounds share at most 96000 tokens and 360 seconds/),
    ).toBeInTheDocument();
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
    fireEvent.click(await ready());
    await waitFor(() =>
      expect(presentationTrialClient.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'serial', confirmed: true }),
      ),
    );
  });
  it('recovers round two without replay, disables mode changes and cancels the same execution', async () => {
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget: serialBudget,
      singleBudget: budget,
      serialBudget,
      execution: { ...execution, mode: 'serial', round: 2 },
    });
    render(<TrialLaunch {...props} />);
    await screen.findByText(/Round 2 of 2/);
    const checkbox = screen.getByRole('checkbox', {
      name: 'Try one serial refinement (two rounds total)',
    });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    vi.mocked(presentationTrialClient.status).mockResolvedValue({
      budget: serialBudget,
      serialBudget,
      execution: { ...execution, mode: 'serial', state: 'cancelled' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel trial' }));
    await screen.findByText('Trial cancelled. The original is preserved.');
    expect(presentationTrialClient.cancel).toHaveBeenCalledWith('task');
    expect(presentationTrialClient.start).not.toHaveBeenCalled();
  });
});
