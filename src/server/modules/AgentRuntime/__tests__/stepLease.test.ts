import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startStepLeaseRenewal,
  StepLeaseBackendError,
  StepLeaseLostError,
  withStepLeaseTimeout,
} from '../stepLease';

const lease = { operationId: 'op', ownerToken: 'owner', stepIndex: 1 };

describe('step lease renewal controller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renews every 10s, supports manual renewal and clears timers on stop', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const controller = startStepLeaseRenewal({ lease, renew, startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(30000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(renew).toHaveBeenLastCalledWith(lease, 35);
    controller.assertHeld();
    await controller.renewNow();
    expect(renew).toHaveBeenCalledTimes(4);
    await controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100000);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  it.each([false, new Error('backend down')])(
    'aborts permanently on lost ownership or backend error (%s)',
    async (outcome) => {
      const renew =
        outcome === false ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(outcome);
      const onLost = vi.fn();
      const controller = startStepLeaseRenewal({ lease, onLost, renew, startedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(10000);
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(StepLeaseLostError);
      expect(() => controller.assertHeld()).toThrow(StepLeaseLostError);
      expect(onLost).toHaveBeenCalledTimes(1);
      await expect(controller.renewNow()).rejects.toBe(controller.signal.reason);
      await vi.advanceTimersByTimeAsync(60000);
      expect(renew).toHaveBeenCalledTimes(1);
      await controller.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('detects event-loop pauses past expiry synchronously without running timers', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const startedAt = Date.now();
    const controller = startStepLeaseRenewal({ lease, renew, startedAt });
    vi.setSystemTime(startedAt + 35000);
    expect(() => controller.assertHeld()).toThrow(StepLeaseLostError);
    expect(controller.signal.aborted).toBe(true);
    expect(renew).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('counts acquisition latency against the initial TTL', async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const controller = startStepLeaseRenewal({ lease, renew, startedAt: Date.now() - 34000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.signal.aborted).toBe(true);
    expect(renew).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('starts aborted when acquisition already consumed the entire TTL', async () => {
    const controller = startStepLeaseRenewal({
      lease,
      renew: vi.fn(),
      startedAt: Date.now() - 35000,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await controller.stop();
  });

  it('times out hung renewal and ignores late successful responses', async () => {
    let resolve!: (held: boolean) => void;
    const renew = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const controller = startStepLeaseRenewal({ lease, renew, startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(15000);
    expect(controller.signal.aborted).toBe(true);
    await controller.stop();
    resolve(true);
    await Promise.resolve();
    expect(() => controller.assertHeld()).toThrow(StepLeaseLostError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot revive after local expiry even if the renewal resolves before overdue timers run', async () => {
    let resolve!: (held: boolean) => void;
    const startedAt = Date.now();
    const renew = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const controller = startStepLeaseRenewal({ lease, renew, startedAt });
    const pending = controller.renewNow();
    const rejected = expect(pending).rejects.toBeInstanceOf(StepLeaseLostError);
    await Promise.resolve();
    vi.setSystemTime(startedAt + 35001);
    resolve(true);
    await rejected;
    expect(controller.signal.aborted).toBe(true);
    await controller.stop();
  });

  it('rejects overdue renewal responses even when the timeout timer has not run', async () => {
    let resolve!: (held: boolean) => void;
    const startedAt = Date.now();
    const renew = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const controller = startStepLeaseRenewal({ lease, renew, startedAt });
    const pending = controller.renewNow();
    const rejected = expect(pending).rejects.toBeInstanceOf(StepLeaseLostError);
    await Promise.resolve();
    vi.setSystemTime(startedAt + 5000);
    resolve(true);
    await rejected;
    expect(controller.signal.aborted).toBe(true);
    await controller.stop();
  });

  it('serializes overlapping renewals and bounds stop while one is pending', async () => {
    const renew = vi.fn(() => new Promise<boolean>(() => {}));
    const controller = startStepLeaseRenewal({ lease, renew, startedAt: Date.now() });
    const first = controller.renewNow();
    const rejected = expect(first).rejects.toBeInstanceOf(StepLeaseLostError);
    expect(controller.renewNow()).toBe(first);
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(1);
    const stopped = controller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures renewed TTL from request start rather than response arrival', async () => {
    const renew = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000)),
    );
    const startedAt = Date.now();
    const controller = startStepLeaseRenewal({ lease, renew, startedAt });
    await vi.advanceTimersByTimeAsync(14000);
    // Renewal began at +10s: local deadline is +45s, not +49s.
    vi.setSystemTime(startedAt + 45000);
    expect(() => controller.assertHeld()).toThrow(StepLeaseLostError);
    await controller.stop();
  });

  it('an onLost observer cannot swallow ownership loss', async () => {
    const controller = startStepLeaseRenewal({
      lease,
      onLost: () => {
        throw new Error('observer');
      },
      renew: vi.fn().mockResolvedValue(false),
      startedAt: Date.now(),
    });
    await expect(controller.renewNow()).rejects.toBeInstanceOf(StepLeaseLostError);
    expect(controller.signal.aborted).toBe(true);
    await controller.stop();
  });
});

describe('bounded step lease backend calls', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects overdue responses even before a paused timeout timer executes', async () => {
    let resolve!: (value: boolean) => void;
    const startedAt = Date.now();
    const pending = withStepLeaseTimeout(
      'acquire',
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(StepLeaseBackendError);
    await Promise.resolve();
    vi.setSystemTime(startedAt + 5000);
    resolve(true);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not dispatch a deferred command if the local deadline already elapsed', async () => {
    const operation = vi.fn().mockResolvedValue(true);
    const startedAt = Date.now();
    const pending = withStepLeaseTimeout('commit', operation);
    vi.setSystemTime(startedAt + 5000);
    await expect(pending).rejects.toBeInstanceOf(StepLeaseBackendError);
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears timeouts on success and synchronous backend errors', async () => {
    await expect(withStepLeaseTimeout('release', async () => true)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      withStepLeaseTimeout('release', () => {
        throw new Error('secret');
      }),
    ).rejects.toMatchObject({
      message: 'Step lease backend failed to release',
      name: 'StepLeaseBackendError',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
