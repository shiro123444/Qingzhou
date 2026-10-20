import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src';
import PresentationStudio from './PresentationStudio';
import type { PresentationClient } from './store/presentationStore';

describe('presentation interruption workspace', () => {
  it.each(['failed', 'cancelled'] as const)(
    'keeps %s work in the studio and resumes the same job',
    async (state) => {
      const job: PresentationJob = {
        artifactIds: [],
        createdAt: '2026-09-21T06:00:00Z',
        error: {
          code: 'PRESENTATION_INTERNAL_ERROR',
          message: '[{"path":["templateId"],"message":"Required"}]',
        },
        jobId: 'recovery-job',
        state,
        updatedAt: '2026-09-21T06:00:00Z',
      };
      const client: PresentationClient = {
        cancelPresentationJob: vi.fn(),
        createPresentationJob: vi.fn(),
        exportArtifact: vi.fn(),
        getArtifact: vi.fn(),
        getPresentationJob: vi.fn(async () => job),
        retryPresentationJob: vi.fn(
          async (): Promise<PresentationJob> => ({ ...job, error: undefined, state: 'queued' }),
        ),
      };
      render(
        <PresentationStudio client={client} initialJobIds={[job.jobId]} pollIntervalMs={60_000} />,
      );
      await screen.findByTestId('presentation-recovery-workspace');
      expect(screen.getByTestId('presentation-conversation-trigger')).toBeInTheDocument();
      expect(screen.queryByTestId('slide-preview-empty')).not.toBeInTheDocument();
      expect(screen.queryByTestId('presentation-generation-workspace')).not.toBeInTheDocument();
      expect(screen.queryByText(/templateId/)).not.toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Presentation job list' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry presentation job' }));
      await waitFor(() => expect(client.retryPresentationJob).toHaveBeenCalledWith(job.jobId));
      expect(client.createPresentationJob).not.toHaveBeenCalled();
      await screen.findByTestId('presentation-generation-workspace');
    },
  );
});
