import '@testing-library/jest-dom/vitest';

import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  presentationLearningClient,
  presentationTrialClient,
} from '@/services/runtime/trialClient';
import type { LearningEpisodeView } from '@/types/presentationTrial';

import TrialLearningHistory from './TrialLearningHistory';

const render = (ui: ReactElement) =>
  testingRender(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
const props = { jobId: 'source', slideId: 's1', visible: true, revision: 0 };
const view: LearningEpisodeView = {
  episodeId: 'episode',
  kind: 'decision',
  status: 'pending-validation',
  source: { jobId: 'source', versionId: 'v1', slideId: 's1' },
  outcome: 'candidate-adopted',
  cue: { domain: 'presentation', title: 'Real source', aspectRatio: '16:9', slideNumber: 1 },
  lesson: {
    applicability: 'source-page-only',
    observation: 'candidate-adopted',
    transfer: 'unverified',
  },
  reason: 'Better grouping',
  reasonProvided: true,
  selectedVariantId: 'candidate',
  result: { status: 'created', jobId: 'new-job', versionId: 'v2' },
  variants: [
    {
      id: 'candidate',
      configurationCompared: true,
      changedPaths: [],
      pageChanged: true,
      previewUri: `/api/runtime/presentation/artifacts/learning-preview-${'a'.repeat(64)}?raw=true`,
      quality: { composition: { score: 3, evidence: 'Clear grouping' } },
      gates: { visual: { status: 'passed', evidence: 'No overflow' } },
      available: { configuration: true, plan: true, preview: true, evaluation: true },
    },
  ],
};
beforeEach(() => {
  vi.spyOn(presentationLearningClient, 'list').mockResolvedValue({
    episodes: [
      { episodeId: view.episodeId, kind: view.kind, status: view.status, outcome: view.outcome },
    ],
  });
  vi.spyOn(presentationLearningClient, 'read').mockResolvedValue(structuredClone(view));
  vi.spyOn(presentationTrialClient, 'choose');
});
afterEach(() => vi.restoreAllMocks());
describe('pending trial experiences', () => {
  it('shows scoped user intent, version, config deltas and real evidence without promoting or applying', async () => {
    render(<TrialLearningHistory {...props} />);
    await screen.findByText('User reason: Better grouping');
    expect(screen.getByText('Pending validation')).toBeInTheDocument();
    expect(screen.getByText(/Transfer is unverified/)).toBeInTheDocument();
    expect(screen.getByText(/new-job.*v2/)).toBeInTheDocument();
    expect(screen.getByText(/Configuration changes: unchanged/)).toBeInTheDocument();
    expect(screen.getByText(/Clear grouping/)).toBeInTheDocument();
    expect(screen.getByText(/No overflow/)).toBeInTheDocument();
    expect(screen.getByAltText('Archived preview: candidate')).toBeInTheDocument();
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
  it('does not invent a reason when the user keeps the original without a note', async () => {
    vi.mocked(presentationLearningClient.read).mockResolvedValue({
      ...view,
      outcome: 'baseline-kept',
      reasonProvided: false,
      reason: undefined,
      result: { jobId: 'source', versionId: 'v1', status: 'kept' },
    });
    render(<TrialLearningHistory {...props} />);
    await screen.findByText('No user reason was supplied. No motive has been inferred.');
    expect(screen.queryByText('User reason: Better grouping')).not.toBeInTheDocument();
  });
  it('shows missing stages and failure evidence instead of zero scores or success', async () => {
    vi.mocked(presentationLearningClient.read).mockResolvedValue({
      ...view,
      kind: 'attempt',
      outcome: 'failed',
      reasonProvided: false,
      reason: undefined,
      failureCode: 'TRIAL_USAGE_EXCEEDED',
      result: undefined,
      variants: [
        {
          id: 'candidate',
          configurationCompared: false,
          changedPaths: [],
          available: { configuration: true, plan: false, preview: false, evaluation: false },
        },
      ],
    });
    render(<TrialLearningHistory {...props} />);
    await screen.findByText('Recorded failure: TRIAL_USAGE_EXCEEDED');
    expect(
      screen.getByText(/Configuration: saved; preview: unavailable; evaluation: unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/0\/4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Configuration changes/)).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
  it('never embeds external or script preview URLs', async () => {
    vi.mocked(presentationLearningClient.read).mockResolvedValue({
      ...view,
      variants: [{ ...view.variants[0], previewUri: 'https://external.example/private.png' }],
    });
    render(<TrialLearningHistory {...props} />);
    await screen.findByText('User reason: Better grouping');
    expect(document.querySelector('img')).toBeNull();
  });
  it('retries archive loading without another trial or confirmation', async () => {
    vi.mocked(presentationLearningClient.list).mockRejectedValueOnce(
      new Error('Temporary read error'),
    );
    render(<TrialLearningHistory {...props} />);
    await screen.findByText(
      'Experiences could not be loaded. The original and trial result remain preserved.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh experiences' }));
    await screen.findByText('User reason: Better grouping');
    await waitFor(() => expect(presentationLearningClient.list).toHaveBeenCalledTimes(2));
    expect(presentationTrialClient.choose).not.toHaveBeenCalled();
  });
});
