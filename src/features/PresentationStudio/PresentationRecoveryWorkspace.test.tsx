import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src';
import PresentationRecoveryWorkspace from './PresentationRecoveryWorkspace';

const failedJob: PresentationJob = {
  createdAt: '2026-10-15T06:38:57.000Z',
  error: { code: 'IMAGE_UNAVAILABLE', message: 'Private upstream response' },
  jobId: 'saved-presentation',
  state: 'failed',
  updatedAt: '2026-10-15T06:50:53.000Z',
};

describe('Presentation recovery failure reason', () => {
  it('explains image generation failure and resumes the same saved job', () => {
    const onRetry = vi.fn(async () => {});
    render(
      <I18nextProvider i18n={i18n}>
        <PresentationRecoveryWorkspace
          busy={false}
          history={null}
          job={failedJob}
          onNew={vi.fn()}
          onRetry={onRetry}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('image service is unavailable');
    expect(screen.queryByText('Private upstream response')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry presentation job' }));
    expect(onRetry).toHaveBeenCalledWith('saved-presentation');
  });

  it('shows other failure codes without exposing provider response content', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PresentationRecoveryWorkspace
          busy={false}
          history={null}
          job={{ ...failedJob, error: { code: 'PPT_MASTER_FAILED', message: 'Private details' } }}
          onNew={vi.fn()}
          onRetry={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('PPT_MASTER_FAILED');
    expect(screen.queryByText('Private details')).not.toBeInTheDocument();
  });

  it('explains the persisted template style conflict from an earlier attempt', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PresentationRecoveryWorkspace
          busy={false}
          history={null}
          job={{
            ...failedJob,
            error: {
              code: 'PRESENTATION_INTERNAL_ERROR',
              message:
                'Choose at most one primary style; borrow other sources as layout or rendering methods',
            },
          }}
          onNew={vi.fn()}
          onRetry={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('conflicting primary styles');
  });
});
