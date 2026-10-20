import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot, PresentationJob } from '../../../../packages/runtime-contracts/src';
import { useJobPolling } from '../hooks/useJobPolling';
import { createPresentationStudioStore, type PresentationStreamClient } from './presentationStore';

const createdAt = '2026-09-15T00:00:00.000Z';
const job: PresentationJob = {
  artifactIds: ['slide'],
  createdAt,
  jobId: 'job',
  state: 'completed',
  updatedAt: createdAt,
};
const slide: ArtifactSnapshot = {
  artifactId: 'slide',
  createdAt,
  metadata: { slideId: 'slide-1' },
  status: 'ready',
  type: 'svg',
  updatedAt: createdAt,
};
const complete = { ...slide, uri: '/preview.svg' };
const client = (): PresentationStreamClient => ({
  cancelPresentationJob: vi.fn(),
  createPresentationJob: vi.fn(),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(async () => complete),
  getPresentationJob: vi.fn(async () => job),
  retryPresentationJob: vi.fn(),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const event = (seq: number, data: unknown) => ({
  data,
  job_id: 'job',
  protocol_version: 'runtime.v1' as const,
  seq,
  type: 'artifact.ready',
});

describe('PPT preview artifact hydration', () => {
  it('hydrates a streamed page while the remaining deck is still running', async () => {
    const transport = client();
    const stop = deferred<void>();
    transport.subscribePresentationJob = vi.fn((_id, options) =>
      (async function* () {
        const onAbort = () => stop.resolve();
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          yield event(1, slide);
          await stop.promise;
        } finally {
          options?.signal?.removeEventListener('abort', onAbort);
        }
      })(),
    );
    const store = createPresentationStudioStore(transport);
    store.setState({
      jobs: { job: { ...job, artifactIds: [], state: 'running' } },
      jobOrder: ['job'],
    });
    const rendered = renderHook(() => useJobPolling(store));
    try {
      await vi.waitFor(() => expect(store.getState().artifacts.slide?.uri).toBe('/preview.svg'));
      expect(store.getState().jobs.job.state).toBe('running');
      expect(transport.getArtifact).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
      stop.resolve();
    }
  });

  it('hydrates partial ready events during completion refresh and preserves complete data on replay', async () => {
    const transport = client();
    const store = createPresentationStudioStore(transport);
    store.setState({ jobs: { job }, selectedJobId: 'job' });
    store.getState().applyPresentationEvent(event(1, slide));
    await store.getState().refreshJob('job');
    expect(store.getState().artifacts.slide.uri).toBe('/preview.svg');
    store
      .getState()
      .applyPresentationEvent(event(2, { ...slide, metadata: { quality: 'checked' } }));
    expect(store.getState().artifacts.slide).toMatchObject({
      uri: '/preview.svg',
      metadata: { slideId: 'slide-1', quality: 'checked' },
    });
    await store.getState().refreshArtifacts('job');
    expect(transport.getArtifact).toHaveBeenCalledOnce();
  });

  it('shares in-flight fetches and never regresses newer events or another job selection', async () => {
    const gate = deferred<ArtifactSnapshot>();
    const transport = client();
    vi.mocked(transport.getArtifact).mockReturnValue(gate.promise);
    const store = createPresentationStudioStore(transport);
    store.setState({ artifacts: { slide }, jobs: { job }, selectedJobId: 'job' });
    const first = store.getState().refreshArtifacts('job');
    const second = store.getState().refreshArtifacts('job');
    store
      .getState()
      .applyPresentationEvent(
        event(1, { ...slide, status: 'failed', updatedAt: '2026-09-15T01:00:00.000Z' }),
      );
    store.setState({ selectedArtifactId: null, selectedJobId: 'other' });
    gate.resolve(complete);
    await Promise.all([first, second]);
    expect(transport.getArtifact).toHaveBeenCalledOnce();
    expect(store.getState().artifacts.slide.status).toBe('failed');
    expect(store.getState().selectedArtifactId).toBeNull();
  });

  it('keeps failed hydration retryable and does not require document preview URIs', async () => {
    const transport = client();
    vi.mocked(transport.getArtifact)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(complete);
    const store = createPresentationStudioStore(transport);
    store.setState({
      artifacts: { slide, deck: { ...slide, artifactId: 'deck', type: 'pptx' } },
      jobs: { job: { ...job, artifactIds: ['slide', 'deck'] } },
    });
    await store.getState().refreshArtifacts('job');
    expect(store.getState().artifacts.slide.uri).toBeUndefined();
    await store.getState().refreshArtifacts('job');
    expect(store.getState().artifacts.slide.uri).toBe('/preview.svg');
    expect(transport.getArtifact).toHaveBeenCalledTimes(2);
    expect(transport.getArtifact).not.toHaveBeenCalledWith('deck');
  });

  it('rejects a fetch returning a different artifact ID', async () => {
    const transport = client();
    vi.mocked(transport.getArtifact).mockResolvedValue({ ...complete, artifactId: 'foreign' });
    const store = createPresentationStudioStore(transport);
    store.setState({ jobs: { job } });
    await store.getState().refreshArtifacts('job');
    expect(store.getState().artifacts).toEqual({});
    expect(store.getState().clientError).toBeTruthy();
  });

  it('keeps completed job state when an older refresh settles after a stream update', async () => {
    const gate = deferred<ArtifactSnapshot>();
    const started = deferred<void>();
    const transport = client();
    vi.mocked(transport.getPresentationJob).mockResolvedValue({ ...job, state: 'running' });
    vi.mocked(transport.getArtifact).mockImplementation(() => {
      started.resolve();
      return gate.promise;
    });
    const store = createPresentationStudioStore(transport);
    store.setState({ artifacts: { slide }, jobs: { job: { ...job, state: 'running' } } });
    const refreshing = store.getState().refreshJob('job');
    await started.promise;
    store.getState().applyPresentationEvent(event(1, job));
    gate.resolve(complete);
    await refreshing;
    expect(store.getState().jobs.job.state).toBe('completed');
    expect(store.getState().artifacts.slide.uri).toBe('/preview.svg');
  });
});
