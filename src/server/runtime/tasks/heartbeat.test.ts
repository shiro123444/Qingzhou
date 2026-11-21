// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import { NativeWorkerSupervisor, type WorkerHeartbeatStore } from './heartbeat';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const fakeStore = () => ({
  register: vi.fn().mockResolvedValue('incarnation'),
  pulse: vi.fn().mockResolvedValue(undefined),
  polling: vi.fn().mockResolvedValue(undefined),
  success: vi.fn().mockResolvedValue(undefined),
  failure: vi.fn().mockResolvedValue(undefined),
  stopping: vi.fn().mockResolvedValue(undefined),
  stopped: vi.fn().mockResolvedValue(undefined),
});

it('keeps a separate heartbeat for long work, never overlaps ticks and drains on stop', async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  let release!: (count: number) => void;
  const worker = {
    tick: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    ),
    stop: vi.fn(async () => {
      release(1);
    }),
  };
  const dispose = await new NativeWorkerSupervisor(
    store as unknown as WorkerHeartbeatStore,
    'agent',
    worker,
  ).start();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(worker.tick).toHaveBeenCalledOnce();
  expect(store.pulse).toHaveBeenCalledTimes(3);
  expect(store.success).not.toHaveBeenCalled();
  await dispose();
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(store.stopped).toHaveBeenCalledWith('incarnation');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.pulse).toHaveBeenCalledTimes(3);
  expect(worker.tick).toHaveBeenCalledOnce();
});

it('reports dependency failures and the next successful poll without leaking exceptions', async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  const worker = {
    tick: vi
      .fn()
      .mockRejectedValueOnce(new Error('private connection string'))
      .mockResolvedValue(0),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const dispose = await new NativeWorkerSupervisor(
    store as unknown as WorkerHeartbeatStore,
    'wake',
    worker,
  ).start();
  await vi.advanceTimersByTimeAsync(0);
  expect(store.failure).toHaveBeenCalledExactlyOnceWith('incarnation');
  expect(store.success).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(store.success).toHaveBeenCalledExactlyOnceWith('incarnation');
  await dispose();
});

it('does not dispatch work or leave timers when heartbeat registration fails', async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  store.register.mockRejectedValue(new Error('migration missing'));
  const worker = { tick: vi.fn(), stop: vi.fn() };
  await expect(
    new NativeWorkerSupervisor(store as unknown as WorkerHeartbeatStore, 'agent', worker).start(),
  ).rejects.toThrow('migration missing');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(worker.tick).not.toHaveBeenCalled();
  expect(store.pulse).not.toHaveBeenCalled();
});
