import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { runtimeClient } from '@/services/runtime/client';

import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src';
import { useCanvasSaveQueue } from './useCanvasSaveQueue';

const deck: PresentationJob = {
  jobId: 'test-deck',
  state: 'completed',
  versionId: 'v0',
  createdAt: '',
  updatedAt: '',
};
const doc = () => new DOMParser().parseFromString('<svg/>', 'image/svg+xml');
const move = (requestId: string): PresentationMessageInput => ({
  requestId,
  target: { type: 'slide', slideNumber: 6 },
  content: 'move',
  canvasCommand: { kind: 'translate', expectedVersionId: 'v0', object: 'table-1', dx: 1, dy: 2 },
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it('recovers a lost reply by receipt and uses its resulting revision for the next gesture', async () => {
  let job = deck;
  vi.spyOn(runtimeClient, 'getPresentationJob').mockImplementation(async () => job);
  const send = vi
    .spyOn(runtimeClient, 'sendPresentationMessage')
    .mockImplementation(async (_, msg) => {
      const versionId = msg.requestId === 'first' ? 'v1' : 'v2';
      job = {
        ...job,
        versionId,
        messages: [
          ...(job.messages ?? []),
          { ...msg, status: 'applied', createdAt: '', versionId },
        ],
      };
      if (msg.requestId === 'first') throw new TypeError('response lost');
      return job;
    });
  const { result } = renderHook(() => useCanvasSaveQueue(deck.jobId));
  act(() => {
    result.current.enqueue(move('first'), 'v0', doc());
    result.current.enqueue(move('second'), 'v0', doc());
  });
  await waitFor(() => expect(result.current.pending).toBe(false), { timeout: 5000 });
  expect(send.mock.calls.map(([, m]) => [m.requestId, m.canvasCommand?.expectedVersionId])).toEqual(
    [
      ['first', 'v0'],
      ['second', 'v1'],
    ],
  );
});

it('keeps offline edits across a remount and stops when a different writer publishes', async () => {
  const get = vi
    .spyOn(runtimeClient, 'getPresentationJob')
    .mockRejectedValue(new TypeError('offline'));
  const send = vi.spyOn(runtimeClient, 'sendPresentationMessage');
  const mounted = renderHook(() => useCanvasSaveQueue(deck.jobId));
  act(() => {
    mounted.result.current.enqueue(move('offline'), 'v0', doc());
  });
  await waitFor(() => expect(mounted.result.current.status).toBe('offline'));
  mounted.unmount();
  get.mockResolvedValue({ ...deck, versionId: 'external-revision' });
  const { result } = renderHook(() => useCanvasSaveQueue(deck.jobId));
  await waitFor(() => expect(result.current.status).toBe('conflict'));
  expect(result.current.pending).toBe(true);
  expect(send).not.toHaveBeenCalled();
  act(() => result.current.discard());
  expect(result.current.pending).toBe(false);
  expect(sessionStorage.length).toBe(0);
});
