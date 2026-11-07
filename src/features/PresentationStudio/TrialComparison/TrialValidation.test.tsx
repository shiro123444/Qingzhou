import '@testing-library/jest-dom/vitest';

import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentationValidationClient } from '@/services/runtime/trialClient';
import type { TrialValidationView } from '@/types/presentationValidation';

import TrialValidation from './TrialValidation';

const render = (ui: ReactElement) =>
  testingRender(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
const targets = [
  { jobId: 'a', expectedVersionId: 'v1', slideId: 's1', title: 'Unseen A', pageNumber: 1 },
  { jobId: 'b', expectedVersionId: 'v2', slideId: 's2', title: 'Unseen B', pageNumber: 2 },
  { jobId: 'a', expectedVersionId: 'v1', slideId: 's3', title: 'Unseen A', pageNumber: 3 },
];
let saved: TrialValidationView;
beforeEach(() => {
  sessionStorage.clear();
  saved = {
    automaticPromotion: false,
    budget: {
      maxTokens: 80000,
      maxCostMicros: 3500000,
      maxDurationMs: 360000,
      maxProbes: 2,
      maxRenders: 4,
      maxEvaluations: 2,
    },
    charged: { tokens: 0, costMicros: 0 },
    episodeId: 'episode',
    manifestDigest: 'a'.repeat(64),
    validationId: 'validation',
    state: 'prepared',
    verdict: 'pending',
    targets: targets.slice(0, 2).map((target) => ({ ...target, outcome: 'not-started' })),
  };
  vi.spyOn(presentationValidationClient, 'options').mockResolvedValue({ targets, validations: [] });
  vi.spyOn(presentationValidationClient, 'create').mockImplementation(async () => saved);
  vi.spyOn(presentationValidationClient, 'status').mockImplementation(async () => saved);
  vi.spyOn(presentationValidationClient, 'start').mockImplementation(async () => {
    saved = { ...saved, state: 'running' };
    return saved;
  });
  vi.spyOn(presentationValidationClient, 'cancel').mockImplementation(async () => {
    saved = { ...saved, state: 'cancelled', verdict: 'insufficient-evidence' };
    return saved;
  });
});
afterEach(() => vi.restoreAllMocks());
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Cross-task validation' }));
  await screen.findByRole('combobox', { name: 'Choose two held-out pages' });
}
async function select(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Choose two held-out pages' }));
  fireEvent.click(await screen.findByText(label));
}
async function freeze() {
  await select('Unseen A · page 1');
  await select('Unseen B · page 2');
  fireEvent.click(screen.getByRole('button', { name: 'Freeze these two pages' }));
  await screen.findByRole('button', { name: 'Confirm and run this cohort once' });
}
describe('explicit held-out cohort UI', () => {
  it('does not fetch or start until opened, and separates freezing from paid execution', async () => {
    render(<TrialValidation episodeId="episode" />);
    expect(presentationValidationClient.options).not.toHaveBeenCalled();
    await open();
    await freeze();
    expect(presentationValidationClient.create).toHaveBeenCalledWith({
      episodeId: 'episode',
      confirmed: true,
      requestId: expect.any(String),
      targets: targets
        .slice(0, 2)
        .map(({ jobId, expectedVersionId, slideId }) => ({ jobId, expectedVersionId, slideId })),
    });
    expect(presentationValidationClient.start).not.toHaveBeenCalled();
    expect(screen.getByText(/80000 tokens and 360 seconds/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run this cohort once' }));
    await waitFor(() =>
      expect(presentationValidationClient.start).toHaveBeenCalledExactlyOnceWith('validation'),
    );
    await screen.findByText('Validating the fixed cohort…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel validation' }));
    await screen.findByText('Cohort cancelled; no automatic restart.');
    expect(presentationValidationClient.cancel).toHaveBeenCalledExactlyOnceWith('validation');
  });
  it('rejects two pages from the same task before sending a manifest', async () => {
    render(<TrialValidation episodeId="episode" />);
    await open();
    await select('Unseen A · page 1');
    await select('Unseen A · page 3');
    expect(screen.getByRole('button', { name: 'Freeze these two pages' })).toBeDisabled();
    expect(presentationValidationClient.create).not.toHaveBeenCalled();
  });
  it('recovers a frozen cohort on refresh without starting or replaying it', async () => {
    saved = { ...saved, state: 'completed', verdict: 'review-ready' };
    vi.mocked(presentationValidationClient.options).mockResolvedValue({
      targets: [],
      validations: [{ validationId: 'validation' }],
    });
    render(<TrialValidation episodeId="episode" />);
    await open();
    expect(await screen.findByText(/Both independent pages improved/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm and run this cohort once' }),
    ).not.toBeInTheDocument();
    expect(presentationValidationClient.start).not.toHaveBeenCalled();
    expect(screen.getByText(/no default promotion/)).toBeInTheDocument();
  });
  it('keeps the same create identity after an uncertain response', async () => {
    vi.mocked(presentationValidationClient.create).mockRejectedValueOnce(
      new TypeError('Disconnected'),
    );
    render(<TrialValidation episodeId="episode" />);
    await open();
    await select('Unseen A · page 1');
    await select('Unseen B · page 2');
    fireEvent.click(screen.getByRole('button', { name: 'Freeze these two pages' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Freeze these two pages' }));
    await screen.findByRole('button', { name: 'Confirm and run this cohort once' });
    const calls = vi.mocked(presentationValidationClient.create).mock.calls;
    expect(calls[1][0].requestId).toBe(calls[0][0].requestId);
    expect(presentationValidationClient.start).not.toHaveBeenCalled();
  });
});
