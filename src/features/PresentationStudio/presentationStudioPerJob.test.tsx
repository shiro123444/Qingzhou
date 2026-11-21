import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src/index';
import PresentationStudio from './PresentationStudio';

const t0 = '2026-08-30T10:00:00.000Z';

const job = (jobId: string, state: PresentationJob['state'] = 'running'): PresentationJob => ({
  createdAt: t0,
  jobId,
  state,
  updatedAt: t0,
});

describe('PresentationStudio selected-job stream status (C-66)', () => {
  it('shows the selected job status (polling) even while its sibling streams live', async () => {
    // job-a degrades to polling; job-b streams live.
    const subscribePresentationJob = vi.fn((jobId: string) => {
      if (jobId === 'job-b') {
        return (async function* () {
          yield {
            data: job(jobId),
            job_id: jobId,
            protocol_version: 'runtime.v1',
            seq: 1,
            type: 'job',
          };
          await new Promise<void>(() => undefined);
        })();
      }
      return (async function* () {
        yield {
          data: job(jobId),
          job_id: jobId,
          protocol_version: 'runtime.v1',
          seq: 1,
          type: 'job',
        };
      })();
    });
    const client = {
      createPresentationJob: vi.fn(),
      getPresentationJob: vi.fn(async (jobId: string) => job(jobId)),
      cancelPresentationJob: vi.fn(),
      retryPresentationJob: vi.fn(),
      getArtifact: vi.fn(),
      exportArtifact: vi.fn(),
      subscribePresentationJob,
    };

    render(
      <PresentationStudio
        initialJobIds={['job-a', 'job-b']}
        client={client}
        pollIntervalMs={50}
        streamReconnectOptions={{ maxReconnectAttempts: 0 }}
      />,
    );

    fireEvent.click(await screen.findByTestId('presentation-job-job-b'));
    await waitFor(() => {
      expect(screen.getByTestId('job-stream-status')).toHaveTextContent('live');
    });

    // Select A: per-job polling — the notice must appear even though B is live
    // (an aggregate-only UI would hide it here).
    fireEvent.click(screen.getByTestId('presentation-job-job-a'));
    await waitFor(() => {
      expect(screen.getByTestId('job-stream-status')).toHaveTextContent('polling');
    });
    expect(screen.queryByTestId('presentation-stream-notice')).not.toBeInTheDocument();

    // Select B back: per-job live — the notice disappears.
    fireEvent.click(screen.getByTestId('presentation-job-job-b'));
    await waitFor(() => {
      expect(screen.getByTestId('job-stream-status')).toHaveTextContent('live');
    });
    expect(screen.queryByTestId('presentation-stream-notice')).not.toBeInTheDocument();
  }, 15000);

  it('recovers running job on re-enter without duplicate creation and resumes from highest seq (C-112-04)', async () => {
    const resumeSeqs: number[] = [];
    const subscribePresentationJob = vi.fn((jobId: string, opts?: { afterSeq?: number }) => {
      resumeSeqs.push(opts?.afterSeq ?? 0);
      return (async function* () {
        yield {
          data: job(jobId, 'running'),
          job_id: jobId,
          protocol_version: 'runtime.v1' as const,
          seq: 3,
          type: 'job',
        };
      })();
    });

    const client = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(async () => job('job-restored', 'queued')),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(async (id: string) => job(id, 'running')),
      retryPresentationJob: vi.fn(),
      subscribePresentationJob,
    };

    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem('presentation_studio_last_seq_job-restored', '2');
    }

    // Remount PresentationStudio with initialJobIds
    const { unmount } = render(
      <PresentationStudio client={client} initialJobIds={['job-restored']} pollIntervalMs={50} />,
    );

    await waitFor(() => {
      expect(client.getPresentationJob).toHaveBeenCalledWith('job-restored');
    });

    // Verify no createPresentationJob call was triggered
    expect(client.createPresentationJob).not.toHaveBeenCalled();

    // Verify stream subscribed and resumed from seq 2
    await waitFor(() => {
      expect(subscribePresentationJob).toHaveBeenCalled();
    });
    expect(resumeSeqs).toContain(2);

    unmount();
  });
});
