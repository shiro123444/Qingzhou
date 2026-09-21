import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot, PresentationJob } from '../../../../packages/runtime-contracts/src';
import { createPresentationStudioStore, type PresentationClient } from '../store/presentationStore';
import { usePresentationStudio } from './usePresentationStudio';

const slide = (version: string, page: number, stableId = `page-${page}`): ArtifactSnapshot => ({
  artifactId: `${version}:slide:${page}`,
  createdAt: '2026-09-12T00:00:00Z',
  metadata: { slideId: stableId, slideNumber: page },
  mimeType: 'image/svg+xml',
  sizeBytes: 12,
  status: 'ready',
  type: 'svg',
  updatedAt: '2026-09-12T00:00:00Z',
  uri: 'data:image/svg+xml,<svg/>',
});

describe('usePresentationStudio version selection', () => {
  it('restores history without opening the previous work on a bare presentation route', async () => {
    window.history.replaceState(null, '', '/presentation');
    window.sessionStorage.setItem('presentation_studio_active_job_id', 'job-previous');
    const previous: PresentationJob = {
      artifactIds: [],
      createdAt: '2026-09-12T00:00:00Z',
      jobId: 'job-previous',
      state: 'completed',
      updatedAt: '2026-09-12T00:00:00Z',
    };
    const client: PresentationClient = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(),
      getPresentationJob: vi.fn(),
      listPresentationJobs: vi.fn(async () => [previous]),
      retryPresentationJob: vi.fn(),
    };
    const store = createPresentationStudioStore(client);

    renderHook(() => usePresentationStudio(store));

    await waitFor(() => expect(store.getState().initialLoading).toBe(false));
    expect(store.getState().jobOrder).toContain('job-previous');
    expect(store.getState().selectedJobId).toBeNull();
    expect(client.getPresentationJob).not.toHaveBeenCalled();
  });

  it.each(['stable slide id', 'page number'])(
    'keeps the selected page after retry while resolving a new version by %s',
    async (identity) => {
      const previous = [slide('v1', 1), slide('v1', 2), slide('v1', 3)];
      const next = [1, 2, 3].map((page) =>
        slide('v2', page, identity === 'page number' ? `revised-${page}` : `page-${page}`),
      );
      const oldJob: PresentationJob = {
        artifactIds: previous.map((artifact) => artifact.artifactId),
        createdAt: '2026-09-12T00:00:00Z',
        jobId: 'job-1',
        state: 'completed',
        updatedAt: '2026-09-12T00:00:00Z',
      };
      const newJob: PresentationJob = {
        ...oldJob,
        artifactIds: next.map((artifact) => artifact.artifactId),
      };
      const client: PresentationClient = {
        cancelPresentationJob: vi.fn(),
        createPresentationJob: vi.fn(),
        exportArtifact: vi.fn(),
        getArtifact: vi.fn(
          async (id) => next.find((artifact) => artifact.artifactId === id) ?? null,
        ),
        getPresentationJob: vi.fn(),
        retryPresentationJob: vi.fn(async () => newJob),
      };
      const store = createPresentationStudioStore(client);
      store.setState({
        artifacts: Object.fromEntries(previous.map((artifact) => [artifact.artifactId, artifact])),
        jobOrder: ['job-1'],
        jobs: { 'job-1': oldJob },
        selectedArtifactId: previous[1].artifactId,
        selectedJobId: 'job-1',
      });
      renderHook(() => usePresentationStudio(store, { initialJobIds: [] }));

      await act(async () => store.getState().retryJob('job-1'));
      expect([previous[1].artifactId, next[1].artifactId]).toContain(
        store.getState().selectedArtifactId,
      );
      await act(async () => store.getState().refreshArtifacts('job-1'));
      expect(store.getState().selectedArtifactId).toBe(next[1].artifactId);
    },
  );
});
