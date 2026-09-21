import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  ExportResult,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import PresentationStudio from './PresentationStudio';

// This suite restores existing decks; the creation conversation is covered separately.
vi.mock('./AgentFlow', () => ({ default: () => null }));

const t0 = '2026-08-30T10:00:00.000Z';

const completedJob = (artifactIds: string[]): PresentationJob => ({
  artifactIds,
  createdAt: t0,
  jobId: 'job-done',
  state: 'completed',
  updatedAt: t0,
});

const slide = (artifactId: string, n: number): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  metadata: { slideNumber: n },
  mimeType: 'image/svg+xml',
  name: `Slide ${n}.svg`,
  sizeBytes: 128,
  status: 'ready',
  type: 'svg',
  updatedAt: t0,
  uri: `data:image/svg+xml,test-${n}`,
});

/**
 * Builds a client whose real restore seam (initialJobIds + getPresentationJob +
 * getArtifact) hydrates a completed two-slide job — the same path production
 * uses; no cross-component store seeding.
 */
const restoredClient = (overrides: Record<string, unknown> = {}) => ({
  cancelPresentationJob: vi.fn(),
  createPresentationJob: vi.fn(),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(async (artifactId: string) =>
    artifactId === 'deck-pptx'
      ? {
          ...slide('deck-pptx', 1),
          type: 'pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }
      : artifactId === 'slide-1'
        ? slide('slide-1', 1)
        : slide('slide-2', 2),
  ),
  getPresentationJob: vi.fn(async (jobId: string) =>
    jobId === 'job-done' ? completedJob(['slide-1', 'slide-2', 'deck-pptx']) : null,
  ),
  retryPresentationJob: vi.fn(),
  ...overrides,
});

const renderRestoredStudio = async (overrides: Record<string, unknown> = {}) => {
  const client = restoredClient(overrides);
  render(
    <PresentationStudio
      client={client as never}
      initialJobIds={['job-done']}
      pollIntervalMs={50}
    />,
  );
  // The restore loop fetches the job and then its artifact snapshots.
  await waitFor(() => {
    expect(screen.getByTestId('artifact-panel-list')).toBeInTheDocument();
  });
  return client;
};

const openExportMenu = async (format: 'pptx' | 'svg') => {
  fireEvent.click(screen.getByRole('button', { name: /Export presentation artifact/i }));
  const menuItem = await screen.findByRole('menuitem', {
    name: format === 'pptx' ? /PowerPoint \(\.pptx\)/ : /矢量切片 \(\.svg\)/,
  });
  fireEvent.click(menuItem.closest('li') ?? menuItem);
};

describe('PresentationStudio export failure recovery (C-80)', () => {
  it.each([
    {
      annotation: undefined,
      code: 'IMAGE_UNAVAILABLE',
      message: 'The image provider is unavailable.',
      requestId: 'resume-image-edit',
    },
    {
      annotation: {
        baseSvgHash: 'hash',
        elementIndices: [6],
        expectedVersionId: 'v1',
        region: { height: 0.2, width: 0.2, x: 0.1, y: 0.1 },
        slideId: 'slide-1',
      },
      code: 'PRESENTATION_INTERNAL_ERROR',
      message: 'Unsafe annotation patch',
      requestId: 'resume-annotation-edit',
    },
  ])(
    'automatically resumes the latest unfinished edit once after $code',
    async ({ annotation, code, message, requestId }) => {
      const failed: PresentationJob = {
        ...completedJob(['slide-1', 'slide-2']),
        error: { code, message },
        messages: [
          {
            annotation,
            content: '继续完成当前修改',
            createdAt: t0,
            error: message,
            requestId,
            status: 'failed',
            target: annotation ? { type: 'slide', slideNumber: 1 } : { type: 'deck' },
          },
        ],
        state: 'failed',
      };
      const retryPresentationJob = vi.fn(async () => ({
        ...failed,
        error: undefined,
        messages: failed.messages?.map((message) => ({ ...message, status: 'queued' as const })),
        state: 'queued' as const,
      }));
      window.sessionStorage.removeItem(
        `presentation_studio_auto_resume:job-done:${requestId}:${code}`,
      );

      await renderRestoredStudio({
        getPresentationJob: vi.fn().mockResolvedValue(failed),
        retryPresentationJob,
      });

      await waitFor(() => expect(retryPresentationJob).toHaveBeenCalledTimes(1));
      expect(retryPresentationJob).toHaveBeenCalledWith('job-done');
    },
  );

  it('exports the retained PPTX after regeneration fails without treating it as a new version', async () => {
    const previous = { ...completedJob(['slide-1', 'slide-2', 'deck-pptx']), versionId: 'v1' };
    const failed: PresentationJob = {
      ...previous,
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'Upstream HTTP 500' },
      state: 'failed',
    };
    const exportArtifact = vi.fn(async () => ({
      artifactId: 'deck-pptx',
      format: 'pptx',
      uri: 'blob:https://studio/retained-v1',
    }));
    const retryPresentationJob = vi.fn().mockResolvedValue(failed);
    await renderRestoredStudio({
      exportArtifact,
      getPresentationJob: vi.fn().mockResolvedValue(previous),
      retryPresentationJob,
    });

    fireEvent.click(screen.getByRole('button', { name: /Retry presentation job/i }));
    await waitFor(() => {
      expect(retryPresentationJob).toHaveBeenCalledWith('job-done');
      expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent(
        'Upstream HTTP 500',
      );
    });
    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Export presentation artifact/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
    await waitFor(() => expect(exportArtifact).toHaveBeenCalledWith('deck-pptx', 'pptx'));
    expect(await screen.findByTestId('presentation-export-download')).toHaveAttribute(
      'href',
      'blob:https://studio/retained-v1',
    );
    await openExportMenu('pptx');
    await waitFor(() => expect(exportArtifact).toHaveBeenCalledTimes(2));
    expect(exportArtifact).toHaveBeenLastCalledWith('deck-pptx', 'pptx');
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('Upstream HTTP 500');
  }, 20000);

  it('keeps export disabled after a failed job when no ready PPTX remains', async () => {
    const exportArtifact = vi.fn();
    await renderRestoredStudio({
      exportArtifact,
      getPresentationJob: vi.fn().mockResolvedValue({
        ...completedJob(['slide-1', 'slide-2']),
        state: 'failed',
      }),
    });

    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Export presentation artifact/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
    expect(exportArtifact).not.toHaveBeenCalled();
  }, 20000);

  it.each(['queued', 'running'] as const)(
    'keeps the retained PPTX export disabled while regeneration is %s',
    async (state) => {
      const exportArtifact = vi.fn();
      await renderRestoredStudio({
        exportArtifact,
        getPresentationJob: vi.fn().mockResolvedValue({
          ...completedJob(['slide-1', 'slide-2', 'deck-pptx']),
          state,
        }),
      });

      expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('正在修改');
      expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Export presentation artifact/i })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
      expect(exportArtifact).not.toHaveBeenCalled();
    },
    20000,
  );

  it('exports PPTX and SVG successfully: one real download link, error cleared', async () => {
    // The mock returns the wire result for the requested format.
    const exportArtifact = vi.fn(
      async (_artifactId: string, format: 'pptx' | 'svg') =>
        ({
          artifactId: 'slide-1',
          format,
          mimeType:
            format === 'pptx'
              ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
              : 'image/svg+xml',
          uri: format === 'pptx' ? 'blob:https://studio/pptx-1' : 'blob:https://studio/svg-1',
        }) satisfies ExportResult,
    );
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('pptx');
    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledWith('deck-pptx', 'pptx');
    });
    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-notice')).toBeInTheDocument();
    });
    // Exactly one real download anchor with the wire URI.
    const download = screen.getByTestId('presentation-export-download');
    expect(download).toHaveAttribute('download');
    expect(download).toHaveAttribute('href', 'blob:https://studio/pptx-1');
    expect(screen.getAllByTestId('presentation-export-download')).toHaveLength(1);
    // Success clears any stale export error and selection survives.
    expect(screen.queryByTestId('presentation-export-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-card-slide-1')).toHaveAttribute('data-selected', 'true');

    await openExportMenu('svg');
    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledWith('slide-1', 'svg');
    });
    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-notice')).toHaveTextContent(
        'Export created (svg): slide-1',
      );
      expect(screen.getByTestId('presentation-export-download')).toHaveAttribute(
        'href',
        'blob:https://studio/svg-1',
      );
    });
  }, 20000);

  it('shows a stable alert for network failures with a keyboard-reachable retry', async () => {
    const exportArtifact = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        artifactId: 'slide-1',
        format: 'svg',
        uri: 'data:image/svg+xml,recovered',
      });
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('svg');
    const errorBox = await screen.findByTestId('presentation-export-error');
    expect(errorBox).toHaveTextContent('Export failed: RUNTIME_ERROR');
    expect(errorBox).toHaveTextContent('Failed to fetch');
    expect(errorBox).toHaveTextContent('nothing was downloaded');
    // No fake success notice and no download link appeared.
    expect(screen.queryByTestId('presentation-export-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-export-download')).not.toBeInTheDocument();

    // Keyboard: focus the retry button, then activate it (jsdom keyDown does
    // not synthesize native button activation — the click proxies Enter).
    const retry = screen.getByTestId('presentation-export-retry');
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.keyDown(retry, { key: 'Enter', code: 'Enter' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledTimes(2);
    });
    // Retry succeeded: error cleared, single real download appears.
    await waitFor(() => {
      expect(screen.queryByTestId('presentation-export-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('presentation-export-download')).toHaveAttribute(
        'href',
        'data:image/svg+xml,recovered',
      );
    });
  });

  it('keeps the structured error code from the backend and retries the same export', async () => {
    const exportArtifact = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 410 ARTIFACT_UNAVAILABLE: source artifact gone'))
      .mockResolvedValueOnce({
        artifactId: 'slide-1',
        format: 'pptx',
        uri: 'blob:https://studio/retry-ok',
      });
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('pptx');
    const errorBox = await screen.findByTestId('presentation-export-error');
    expect(errorBox).toHaveTextContent('Export failed: ARTIFACT_UNAVAILABLE');
    expect(errorBox).toHaveTextContent('source artifact gone');

    fireEvent.click(screen.getByTestId('presentation-export-retry'));
    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledTimes(2);
    });
    // The same artifact + format is retried, not a fabricated new export.
    expect(exportArtifact).toHaveBeenNthCalledWith(2, 'deck-pptx', 'pptx');
    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-download')).toHaveAttribute(
        'href',
        'blob:https://studio/retry-ok',
      );
    });
  });

  it('treats an empty binary payload as a failure without a download link', async () => {
    const exportArtifact = vi.fn(async () => ({
      artifactId: 'slide-1',
      format: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      uri: undefined,
    }));
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('pptx');
    const errorBox = await screen.findByTestId('presentation-export-error');
    expect(errorBox).toHaveTextContent('Export failed: EXPORT_EMPTY_PAYLOAD');
    expect(errorBox).toHaveTextContent('without downloadable content');
    // Honest failure: no success notice, no download anchor.
    expect(screen.queryByTestId('presentation-export-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-export-download')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-export-retry')).toBeInTheDocument();
  });

  it('disables the export surface with aria-busy while the export is in flight', async () => {
    let resolveExport: (result: ExportResult) => void = () => undefined;
    const exportArtifact = vi.fn(
      () =>
        new Promise<ExportResult>((resolve) => {
          resolveExport = resolve;
        }),
    );
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('svg');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Export presentation artifact/i })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /Export presentation artifact/i })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    resolveExport({ artifactId: 'slide-1', format: 'svg', uri: 'data:image/svg+xml,late' });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Export presentation artifact/i }),
      ).not.toBeDisabled();
    });
    expect(screen.getByTestId('presentation-export-download')).toBeInTheDocument();
  });

  it('preserves the selection, artifacts and composer draft through an export failure', async () => {
    const exportArtifact = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 500 EXPORT_FAILED: boom'))
      .mockResolvedValueOnce({
        artifactId: 'slide-1',
        format: 'svg',
        uri: 'data:image/svg+xml,after-failure',
      });
    await renderRestoredStudio({ exportArtifact });

    // A draft exists in the composer before the failure.
    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Unfinished draft' },
    });

    await openExportMenu('svg');
    const errorBox = await screen.findByTestId('presentation-export-error');
    expect(errorBox).toHaveTextContent('Export failed: EXPORT_FAILED');

    // Selection and artifacts survive the failure untouched.
    expect(screen.getByTestId('artifact-card-slide-1')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('artifact-card-slide-2')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-job-job-done')).toBeInTheDocument();
    expect(screen.getByLabelText('Presentation title')).toHaveValue('Unfinished draft');

    // The retry targets exactly the same artifact + format and succeeds.
    fireEvent.click(screen.getByTestId('presentation-export-retry'));
    await waitFor(() => {
      expect(exportArtifact).toHaveBeenCalledTimes(2);
    });
    expect(exportArtifact).toHaveBeenNthCalledWith(2, 'slide-1', 'svg');
    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-download')).toHaveAttribute(
        'href',
        'data:image/svg+xml,after-failure',
      );
    });
    // The draft is still there after the successful retry.
    expect(screen.getByLabelText('Presentation title')).toHaveValue('Unfinished draft');
  });

  it('never fires a download when only the error path runs and clears on dismiss', async () => {
    const exportArtifact = vi.fn().mockRejectedValue(new Error('network gone'));
    await renderRestoredStudio({ exportArtifact });

    await openExportMenu('svg');
    await screen.findByTestId('presentation-export-error');

    expect(screen.queryByTestId('presentation-export-download')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-export-notice')).not.toBeInTheDocument();
    // Dismissing the error clears it honestly.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('presentation-export-error')).not.toBeInTheDocument();
    });
  });
});
