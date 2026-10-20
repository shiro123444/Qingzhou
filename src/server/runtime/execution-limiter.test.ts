import { describe, expect, it, vi } from 'vitest';

import { ExecutionLimiter } from './execution-limiter';
import { getResourceBudget } from './resource-budget';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('expensive operation capacity', () => {
  it('bounds concurrent work and refuses excess queued work without starting it', async () => {
    const gate = new ExecutionLimiter(1, 1);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const queued = vi.fn(async () => 'next');
    const second = gate.run(queued);
    const excess = vi.fn(async () => 'never');
    await expect(gate.run(excess)).rejects.toMatchObject({ code: 'CAPACITY_BUSY' });
    expect(gate.snapshot()).toEqual({ active: 1, queued: 1 });
    expect(queued).not.toHaveBeenCalled();
    expect(excess).not.toHaveBeenCalled();
    hold.resolve();
    await first;
    await expect(second).resolves.toBe('next');
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('removes cancelled waiters and preserves capacity for later requests', async () => {
    const gate = new ExecutionLimiter(1, 1);
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const cancellation = new AbortController();
    const operation = vi.fn(async () => 'cancelled');
    const second = gate.run(operation, cancellation.signal);
    cancellation.abort();
    await expect(second).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(gate.snapshot()).toEqual({ active: 1, queued: 0 });
    const third = gate.run(async () => 'last');
    hold.resolve();
    await first;
    await expect(third).resolves.toBe('last');
    expect(operation).not.toHaveBeenCalled();
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it('releases a slot on failure and rejects already cancelled work', async () => {
    const gate = new ExecutionLimiter(1, 0);
    await expect(
      gate.run(async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    const operation = vi.fn(async () => 'never');
    await expect(gate.run(operation, AbortSignal.abort())).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    expect(operation).not.toHaveBeenCalled();
    await expect(gate.run(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('selects explicit small-server budgets and rejects misspelled profiles', () => {
    expect(getResourceBudget('4c4g').assetConcurrency).toBe(1);
    expect(getResourceBudget('8c8g').assetConcurrency).toBe(2);
    expect(() => getResourceBudget('4g')).toThrow('QINGZHOU_SERVER_PROFILE');
  });
});
