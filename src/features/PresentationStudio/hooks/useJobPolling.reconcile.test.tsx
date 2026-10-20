import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src';
import {
  createPresentationStudioStore,
  type PresentationStreamClient,
  type PresentationStudioStoreHook,
} from '../store/presentationStore';
import { useJobPolling } from './useJobPolling';

const failed: PresentationJob = {
  createdAt: '2026-09-21T06:00:00Z',
  error: { code: 'PRESENTATION_INTERNAL_ERROR', message: 'Required' },
  jobId: 'resume',
  state: 'failed',
  updatedAt: '2026-09-21T06:00:00Z',
};
const completed: PresentationJob = {
  ...failed,
  error: undefined,
  state: 'completed',
  updatedAt: '2026-09-21T06:10:00Z',
};
const Harness = ({ store }: { store: PresentationStudioStoreHook }) => {
  useJobPolling(store);
  return null;
};
const setup = (subscribePresentationJob?: PresentationStreamClient['subscribePresentationJob']) => {
  const client: PresentationStreamClient = {
    cancelPresentationJob: vi.fn(),
    createPresentationJob: vi.fn(),
    exportArtifact: vi.fn(),
    getArtifact: vi.fn(),
    getPresentationJob: vi.fn(async () => completed),
    retryPresentationJob: vi.fn(),
    subscribePresentationJob,
  };
  const store = createPresentationStudioStore(client);
  store.setState({
    jobs: { resume: failed },
    selectedJobId: failed.jobId,
    jobOrder: [failed.jobId],
  });
  return { client, store };
};

describe('presentation authoritative state reconciliation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['focus', 'online'])(
    'refreshes a stale failure on %s without recreating work',
    async (event) => {
      const { client, store } = setup();
      const view = render(<Harness store={store} />);
      await act(async () => {
        window.dispatchEvent(new Event(event));
      });
      expect(store.getState().jobs.resume).toEqual(completed);
      expect(client.createPresentationJob).not.toHaveBeenCalled();
      expect(client.retryPresentationJob).not.toHaveBeenCalled();
      view.unmount();
      await act(async () => {
        window.dispatchEvent(new Event(event));
      });
      expect(client.getPresentationJob).toHaveBeenCalledTimes(1);
    },
  );

  it('reconciles visible terminal work periodically and leaves other history untouched', async () => {
    const { client, store } = setup();
    store.setState({ jobs: { resume: failed, other: { ...failed, jobId: 'other' } } });
    const view = render(<Harness store={store} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(store.getState().jobs.resume.state).toBe('completed');
    expect(store.getState().jobs.other.state).toBe('failed');
    expect(client.getPresentationJob).toHaveBeenCalledExactlyOnceWith('resume');
    view.unmount();
  });

  it('recovers completion even when a connected stream stays silent', async () => {
    const subscribe = vi.fn<NonNullable<PresentationStreamClient['subscribePresentationJob']>>(
      async function* (jobId, options) {
        yield {
          data: { ...failed, error: undefined, state: 'running' },
          job_id: jobId,
          protocol_version: 'runtime.v1',
          seq: 1,
          type: 'job',
        };
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    );
    const { store } = setup(subscribe);
    store.setState({ jobs: { resume: { ...failed, error: undefined, state: 'running' } } });
    const view = render(<Harness store={store} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(store.getState().jobs.resume.state).toBe('completed');
    view.unmount();
  });
});
