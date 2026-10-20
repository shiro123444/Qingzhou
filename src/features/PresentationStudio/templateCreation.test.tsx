import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentationTemplateClient } from '@/services/runtime/templateClient';

import type { PresentationJobInput } from '../../../packages/runtime-contracts/src';
import PresentationStudio from './PresentationStudio';
import type { PresentationClient } from './store/presentationStore';

// This suite checks both creation handoffs; the conversation has its own coverage.
vi.mock('./AgentFlow', () => ({
  default: ({ onCreate }: { onCreate: (input: PresentationJobInput) => void }) => (
    <button
      onClick={() =>
        onCreate({
          notebookId: 'studio',
          options: { style: 'minimal' },
          sourceVersionIds: [],
          title: 'Agent deck',
        })
      }
    >
      Confirm agent creation
    </button>
  ),
}));

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/presentation');
});
afterEach(() => vi.restoreAllMocks());

describe('new presentation template selection', () => {
  it.each(['composer', 'agent'] as const)(
    'pins the selected template for the %s creation flow',
    async (mode) => {
      vi.spyOn(presentationTemplateClient, 'list').mockResolvedValue([
        { name: 'Soft white', templateId: 'template-soft', versionId: 'template-v3' },
      ]);
      const createPresentationJob = vi
        .fn()
        .mockRejectedValue(new Error('Test stops at creation boundary'));
      const client: PresentationClient = {
        cancelPresentationJob: vi.fn(),
        createPresentationJob,
        exportArtifact: vi.fn(),
        getArtifact: vi.fn(),
        getPresentationJob: vi.fn(),
        retryPresentationJob: vi.fn(),
      };
      render(
        <I18nextProvider i18n={i18n}>
          <PresentationStudio client={client} initialJobIds={[]} />
        </I18nextProvider>,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Templates' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Use Soft white' }));
      expect(screen.getByRole('button', { name: 'Templates' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      if (mode === 'composer') {
        fireEvent.click(screen.getByRole('button', { name: 'Create directly' }));
        fireEvent.change(screen.getByLabelText('Presentation title'), {
          target: { value: 'Direct deck' },
        });
        fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm agent creation' }));
      }

      await waitFor(() => expect(createPresentationJob).toHaveBeenCalledOnce());
      expect(createPresentationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ templateVersionId: 'template-v3' }),
          template: 'template-soft',
        }),
      );
      if (mode === 'agent')
        expect(createPresentationJob.mock.calls[0][0].options.style).toBe('minimal');
    },
    20000,
  );

  it('opens a fresh draft without deleting the previous presentation and updates the new job URL', async () => {
    const oldJob = {
      artifactIds: [],
      createdAt: '2026-09-12T00:00:00Z',
      jobId: 'job-old',
      state: 'completed' as const,
      updatedAt: '2026-09-12T00:00:00Z',
    };
    const newJob = { ...oldJob, jobId: 'job-new' };
    const client: PresentationClient = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn().mockResolvedValue(newJob),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn().mockResolvedValue(oldJob),
      retryPresentationJob: vi.fn(),
    };
    window.history.replaceState(null, '', '/presentation?jobId=job-old&hl=zh-CN');
    render(
      <I18nextProvider i18n={i18n}>
        <PresentationStudio client={client} initialJobIds={['job-old']} />
      </I18nextProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New presentation' }));
    expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    expect(await screen.findByTestId('presentation-job-job-old')).toBeInTheDocument();
    expect(window.location.search).toBe('?hl=zh-CN');
    expect(window.sessionStorage.getItem('presentation_studio_active_job_id')).toBeNull();
    expect(client.cancelPresentationJob).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm agent creation' }));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('jobId')).toBe('job-new'),
    );
    expect(window.sessionStorage.getItem('presentation_studio_active_job_id')).toBe('job-new');
    fireEvent.click(await screen.findByRole('button', { name: 'New presentation' }));
    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    expect(screen.getByTestId('presentation-job-job-old')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-job-job-new')).toBeInTheDocument();
  }, 40_000);
});
