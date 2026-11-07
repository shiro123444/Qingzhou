import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  presentationLearningClient,
  presentationTrialClient,
  TrialRequestError,
} from '@/services/runtime/trialClient';
import type { TrialReviewView } from '@/types/presentationTrial';

import TrialComparison from './index';

const render = (ui: ReactElement) =>
  testingRender(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
const props = { jobId: 'source', versionId: 'v1', slideId: 's1' };
const view: TrialReviewView = {
  runId: 'run',
  evidenceDigest: 'a'.repeat(64),
  source: { jobId: 'source', versionId: 'v1', slideId: 's1' },
  recommendedId: 'candidate',
  variants: [
    {
      id: 'baseline',
      selectable: true,
      previewUri: '/api/runtime/presentation/artifacts/baseline?raw=true',
    },
    {
      id: 'candidate',
      selectable: true,
      previewUri: '/api/runtime/presentation/artifacts/candidate?raw=true',
      quality: { composition: { score: 3, evidence: 'Balanced actual pixels' } },
      gates: { visual: { status: 'passed', evidence: 'No overlap' } },
    },
  ],
};
beforeEach(() => {
  vi.spyOn(presentationLearningClient, 'list').mockResolvedValue({ episodes: [] });
  vi.spyOn(presentationTrialClient, 'status').mockResolvedValue({
    budget: {
      maxProbes: 1,
      maxRenders: 2,
      maxEvaluations: 1,
      maxTokens: 48000,
      maxCostMicros: 2000000,
      maxDurationMs: 180000,
    },
  });
  vi.spyOn(presentationTrialClient, 'list').mockResolvedValue({ trials: [{ runId: 'run' }] });
  vi.spyOn(presentationTrialClient, 'read').mockResolvedValue(structuredClone(view));
  vi.spyOn(presentationTrialClient, 'choose').mockResolvedValue({
    status: 'created',
    jobId: 'new-version',
    versionId: 'v2',
  });
});
afterEach(() => vi.restoreAllMocks());
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Compare page trials' }));
  await screen.findByRole('radio', { name: 'Candidate 1' });
}
function loadPreviews() {
  for (const element of document.querySelectorAll('img')) fireEvent.load(element);
}

describe('explicit representative-page comparison', () => {
  it('shows real previews and evidence without preselecting the recommended candidate', async () => {
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    expect(screen.getByText(/Balanced actual pixels/)).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
  it('requires a deliberate selection plus confirmation and switches only after the new version is saved', async () => {
    const onCreated = vi.fn();
    render(<TrialComparison {...props} onCreated={onCreated} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create a new version/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-version'));
    expect(presentationTrialClient.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'source',
        runId: 'run',
        expectedVersionId: 'v1',
        variantId: 'candidate',
        confirmed: true,
        evidenceDigest: view.evidenceDigest,
        requestId: expect.any(String),
      }),
    );
  });
  it('records a baseline choice without opening a new version', async () => {
    vi.mocked(presentationTrialClient.choose).mockResolvedValue({
      status: 'kept',
      jobId: 'source',
      versionId: 'v1',
    });
    const onCreated = vi.fn();
    render(<TrialComparison {...props} onCreated={onCreated} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm keeping the original/ }));
    await screen.findByText('The original was kept. Your choice has been recorded.');
    expect(onCreated).not.toHaveBeenCalled();
  });
  it('blocks stale source versions', async () => {
    vi.mocked(presentationTrialClient.read).mockResolvedValue({
      ...view,
      source: { ...view.source, versionId: 'old' },
    });
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    expect(screen.getByRole('radio', { name: 'Candidate 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
  it('does not permit a choice before previews load or after a broken preview', async () => {
    render(<TrialComparison {...props} />);
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
    const image = screen.getByAltText('Candidate 1');
    fireEvent.error(image);
    loadPreviews();
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
  it('shows a CAS conflict and prevents another confirmation of the stale evidence', async () => {
    vi.mocked(presentationTrialClient.choose).mockRejectedValue(
      new TrialRequestError('PRESENTATION_CONFLICT', 409),
    );
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create a new version/ }));
    await screen.findByText(
      'The source has changed or is being edited. Refresh and compare the latest version.',
    );
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
  });
  it('reuses the request identity after an uncertain network failure', async () => {
    vi.mocked(presentationTrialClient.choose).mockRejectedValueOnce(new Error('Disconnected'));
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create a new version/ }));
    await screen.findByText(
      'The request could not be completed. You can retry with the same choice.',
    );
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create a new version/ }));
    await waitFor(() => expect(presentationTrialClient.choose).toHaveBeenCalledTimes(2));
    expect(vi.mocked(presentationTrialClient.choose).mock.calls[0][0].requestId).toBe(
      vi.mocked(presentationTrialClient.choose).mock.calls[1][0].requestId,
    );
  });
  it('retains a saved result if opening the new job fails, without creating it again', async () => {
    render(
      <TrialComparison
        {...props}
        onCreated={async () => {
          throw new Error('Refresh failed');
        }}
      />,
    );
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create a new version/ }));
    await screen.findByText(
      'The new version was saved, but could not be opened. Refresh the presentation list.',
    );
    expect(presentationTrialClient.choose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Confirm and create a new version/ })).toBeDisabled();
  });
  it('blocks an ineligible candidate while allowing the original to be kept', async () => {
    vi.mocked(presentationTrialClient.read).mockResolvedValue({
      ...view,
      variants: [view.variants[0], { ...view.variants[1], selectable: false }],
    });
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    expect(screen.getByRole('radio', { name: 'Candidate 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    expect(screen.getByRole('button', { name: /Confirm keeping the original/ })).toBeEnabled();
  });
  it('prevents duplicate submissions while a confirmation is pending', async () => {
    let finish!: (value: { status: 'created'; jobId: string; versionId: string }) => void;
    vi.mocked(presentationTrialClient.choose).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Candidate 1' }));
    const confirm = screen.getByRole('button', { name: /Confirm and create a new version/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(presentationTrialClient.choose).toHaveBeenCalledOnce();
    expect(screen.getByRole('radio', { name: 'Original' })).toBeDisabled();
    finish({ status: 'created', jobId: 'new-version', versionId: 'v2' });
    await screen.findByText(
      'A new version was created. The original and trial evidence are retained.',
    );
  });
  it('opens a newly completed trial even if an older list request finishes later', async () => {
    const budget = {
      maxProbes: 1,
      maxRenders: 2,
      maxEvaluations: 1,
      maxTokens: 48000,
      maxCostMicros: 2000000,
      maxDurationMs: 180000,
    };
    let finishList!: (value: { trials: { runId: string }[] }) => void;
    vi.mocked(presentationTrialClient.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );
    const execution = {
      executionId: 'task',
      requestId: 'id',
      source: view.source,
      state: 'completed' as const,
      phase: 'finalizing' as const,
      startedAt: '',
      updatedAt: '',
      runId: 'fresh-run',
    };
    vi.mocked(presentationTrialClient.status)
      .mockResolvedValueOnce({ budget })
      .mockResolvedValue({ budget, execution });
    vi.spyOn(presentationTrialClient, 'start').mockResolvedValue({ budget, execution });
    vi.mocked(presentationTrialClient.read).mockResolvedValue({ ...view, runId: 'fresh-run' });
    render(<TrialComparison {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Compare page trials' }));
    const start = await screen.findByRole('button', { name: 'Confirm and start one trial' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await screen.findByRole('radio', { name: 'Candidate 1' });
    await act(async () => finishList({ trials: [] }));
    expect(screen.getByRole('radio', { name: 'Candidate 1' })).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
  it('sends the optional explicit reason with the confirmed choice', async () => {
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for this choice (optional)' }), {
      target: { value: '  Better body grouping  ' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    vi.mocked(presentationTrialClient.choose).mockResolvedValue({
      status: 'kept',
      jobId: 'source',
      versionId: 'v1',
      learningEpisodeId: 'episode',
      learningStatus: 'recorded',
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm keeping the original/ }));
    await waitFor(() =>
      expect(presentationTrialClient.choose).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Better body grouping',
          confirmed: true,
          variantId: 'baseline',
        }),
      ),
    );
  });
  it('preserves a saved choice when experience archiving is pending', async () => {
    vi.mocked(presentationTrialClient.choose).mockResolvedValue({
      status: 'kept',
      jobId: 'source',
      versionId: 'v1',
      learningStatus: 'pending',
    });
    render(<TrialComparison {...props} />);
    await open();
    loadPreviews();
    fireEvent.click(screen.getByRole('radio', { name: 'Original' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm keeping the original/ }));
    await screen.findByText(
      'Your choice was saved. Experience archiving is pending; refresh experiences to retry.',
    );
    expect(
      screen.getByText('The original was kept. Your choice has been recorded.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm keeping the original/ })).toBeDisabled();
  });
});

it('shows the proposed configuration hypothesis and rationale without selecting a version', async () => {
  vi.mocked(presentationTrialClient.read).mockResolvedValue({
    ...view,
    proposal: {
      dimension: 'textSpacing',
      value: 'comfortable',
      rationale: 'Try more paragraph spacing; retain every word',
      experienceCount: 1,
    },
  });
  render(<TrialComparison {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Compare page trials' }));
  expect(
    await screen.findByText('Try more paragraph spacing; retain every word'),
  ).toBeInTheDocument();
  expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(
    true,
  );
  expect(presentationTrialClient.choose).not.toHaveBeenCalled();
});

describe('serial result review', () => {
  it('shows accumulated evidence without automatically selecting the recommendation', async () => {
    vi.mocked(presentationTrialClient.read).mockResolvedValue({
      ...structuredClone(view),
      improvement: {
        rounds: 2,
        selectedRound: 1,
        charged: { tokens: 8030, costMicros: 2250000 },
        refinementFailed: true,
      },
    });
    render(<TrialComparison {...props} />);
    await open();
    expect(
      screen.getByText(
        'Final comparison uses round 1; 8030 tokens recorded across both rounds. Choose explicitly to create a new version.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The refinement failed or proposed no configuration change/),
    ).toBeInTheDocument();
    loadPreviews();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
});
