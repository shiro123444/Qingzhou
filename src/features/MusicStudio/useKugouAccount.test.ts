import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { musicAccountClient } from '@/services/music-account';
import { type MusicAccountPoll, type MusicAccountStatus } from '@/types/music-account';

import { useKugouAccount } from './useKugouAccount';

const disconnected: MusicAccountStatus = { revision: 'anonymous', state: 'disconnected' };
const connected: MusicAccountStatus = {
  displayName: 'Listener',
  revision: 'linked',
  state: 'connected',
};
const makeChallenge = () => ({
  challengeId: 'd7753797-572d-490e-b151-d78248f531e7',
  expiresAt: Date.now() + 120_000,
  pollAfterMs: 2000,
  qrUrl: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=test-only',
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(musicAccountClient, 'status').mockResolvedValue(disconnected);
  vi.spyOn(musicAccountClient, 'start').mockImplementation(async () => makeChallenge());
  vi.spyOn(musicAccountClient, 'poll').mockResolvedValue({ pollAfterMs: 2000, state: 'waiting' });
  vi.spyOn(musicAccountClient, 'cancel').mockResolvedValue(disconnected);
  vi.spyOn(musicAccountClient, 'disconnect').mockResolvedValue(disconnected);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(userId: string | null = 'alice') {
  const onChanged = vi.fn();
  const onBeforeDisconnect = vi.fn();
  const hook = renderHook(
    ({ account }) => useKugouAccount({ onBeforeDisconnect, onChanged, userId: account }),
    {
      initialProps: { account: userId },
    },
  );
  return { ...hook, onBeforeDisconnect, onChanged };
}

it('polls one QR attempt through phone confirmation and refreshes playback once connected', async () => {
  vi.mocked(musicAccountClient.poll)
    .mockResolvedValueOnce({ pollAfterMs: 2000, state: 'scanned' })
    .mockResolvedValueOnce({ account: connected, pollAfterMs: 2000, state: 'connected' });
  const hook = setup();
  await act(async () => hook.result.current.show());
  expect(hook.result.current.phase).toBe('waiting');
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(hook.result.current.phase).toBe('scanned');
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(hook.result.current.account).toEqual(connected);
  expect(hook.result.current.challenge).toBeUndefined();
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(musicAccountClient.poll).toHaveBeenCalledTimes(2);
});

it('cancels a closed QR and discards a transport response that ignores cancellation', async () => {
  let resolvePoll!: (value: MusicAccountPoll) => void;
  vi.mocked(musicAccountClient.poll).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const hook = setup();
  await act(async () => hook.result.current.show());
  await act(() => vi.advanceTimersByTimeAsync(2000));
  const signal = vi.mocked(musicAccountClient.poll).mock.calls[0][1]!;
  act(() => hook.result.current.close());
  expect(signal.aborted).toBe(true);
  expect(musicAccountClient.cancel).toHaveBeenCalledWith(makeChallenge().challengeId);
  await act(async () => resolvePoll({ account: connected, pollAfterMs: 2000, state: 'connected' }));
  expect(hook.result.current.open).toBe(false);
  expect(hook.result.current.account?.state).not.toBe('connected');
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('does not show another Qingzhou account QR or accept its late login', async () => {
  let resolvePoll!: (value: MusicAccountPoll) => void;
  vi.mocked(musicAccountClient.poll).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  const hook = setup();
  await act(async () => hook.result.current.show());
  await act(() => vi.advanceTimersByTimeAsync(2000));
  hook.rerender({ account: 'bob' });
  expect(hook.result.current.challenge).toBeUndefined();
  expect(hook.result.current.open).toBe(false);
  await act(async () => resolvePoll({ account: connected, pollAfterMs: 2000, state: 'connected' }));
  expect(hook.result.current.account?.state).toBe('disconnected');
  expect(hook.onChanged).not.toHaveBeenCalled();
});

it('reconciles a login committed before QR close without accepting the late poll response', async () => {
  let resolvePoll!: (value: MusicAccountPoll) => void;
  vi.mocked(musicAccountClient.poll).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  vi.mocked(musicAccountClient.cancel).mockResolvedValue(connected);
  const hook = setup();
  await act(async () => {});
  await act(async () => hook.result.current.show());
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await act(async () => hook.result.current.close());
  expect(hook.result.current.open).toBe(false);
  expect(hook.result.current.challenge).toBeUndefined();
  expect(hook.result.current.account).toEqual(connected);
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
  await act(async () => resolvePoll({ account: connected, pollAfterMs: 2000, state: 'connected' }));
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
  vi.mocked(musicAccountClient.status).mockResolvedValue(connected);
  await act(async () => hook.result.current.show());
  expect(musicAccountClient.start).toHaveBeenCalledTimes(1);
  expect(hook.result.current.account).toEqual(connected);
});

it('expires and cancels the QR without keeping a polling timer alive', async () => {
  vi.mocked(musicAccountClient.start).mockImplementation(async () => ({
    ...makeChallenge(),
    expiresAt: Date.now() + 2500,
  }));
  const hook = setup();
  await act(async () => hook.result.current.show());
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(hook.result.current.phase).toBe('expired');
  expect(hook.result.current.challenge).toBeUndefined();
  expect(musicAccountClient.cancel).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(musicAccountClient.poll).toHaveBeenCalledTimes(1);
});

it('invalidates cached account audio before disconnect and refreshes only after success', async () => {
  vi.mocked(musicAccountClient.status).mockResolvedValue(connected);
  let complete!: (status: MusicAccountStatus) => void;
  vi.mocked(musicAccountClient.disconnect).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const hook = setup();
  await act(async () => {});
  let operation!: Promise<void>;
  act(() => {
    operation = hook.result.current.disconnect();
  });
  expect(hook.onBeforeDisconnect).toHaveBeenCalledTimes(1);
  expect(hook.onChanged).not.toHaveBeenCalled();
  expect(hook.result.current.busy).toBe(true);
  await act(async () => {
    complete(disconnected);
    await operation;
  });
  expect(hook.result.current.account?.state).toBe('disconnected');
  expect(hook.onChanged).toHaveBeenCalledTimes(1);
  expect(hook.result.current.busy).toBe(false);
});
