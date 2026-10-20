import { randomUUID } from 'node:crypto';

import { type StepLease } from './types';

export const DEFAULT_STEP_LEASE_TTL_SECONDS = 35;

/** A backend failure is NOT contention and must never permit execution. */
export class StepLeaseBackendError extends Error {
  constructor(action: 'acquire' | 'renew' | 'release' | 'commit', cause: unknown) {
    super(`Step lease backend failed to ${action}`, { cause });
    this.name = 'StepLeaseBackendError';
  }
}

/**
 * Bound all lease backend calls, including acquisition and cleanup. Redis cannot
 * cancel an already sent command: a timed-out commit has an unknown outcome and
 * callers must reconcile durable state, never continue from a late response.
 */
export const withStepLeaseTimeout = async <T>(
  action: 'acquire' | 'renew' | 'release' | 'commit',
  operation: () => Promise<T>,
): Promise<T> => {
  const timeoutMs = 5_000;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () =>
    new StepLeaseBackendError(action, new Error('Step lease command timed out'));
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (Date.now() - startedAt >= timeoutMs) throw timeoutError();
        return operation();
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
    // Also reject delayed responses when a paused event loop has not run its timer.
    if (Date.now() - startedAt >= timeoutMs) throw timeoutError();
    return result;
  } catch (error) {
    if (error instanceof StepLeaseBackendError) throw error;
    throw new StepLeaseBackendError(action, error);
  } finally {
    clearTimeout(timer);
  }
};

export class StepLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super('Step lease ownership was lost', { cause });
    this.name = 'StepLeaseLostError';
  }
}

export const stepLeaseTtlMs = (ttlSeconds: number): number => {
  const milliseconds = ttlSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError('Step lease TTL must be a positive safe integer in milliseconds');
  }
  return milliseconds;
};

export const createStepLease = (operationId: string, stepIndex: number): StepLease => ({
  operationId,
  ownerToken: randomUUID(),
  stepIndex,
});

export const assertStepLeaseOperation = (operationId: string, lease: StepLease): void => {
  if (lease.operationId !== operationId) throw new TypeError('Step lease operation mismatch');
};

export const RENEW_STEP_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

export const RELEASE_STEP_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

// All authoritative state/metadata writes happen in the same Redis turn as the
// ownership check. This does not fence external side effects already dispatched.
export const COMMIT_STEP_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local function validType(key, expected)
  local kind = redis.call('TYPE', key).ok
  return kind == 'none' or kind == expected
end
-- Redis Lua isolates writes but does not roll back a later WRONGTYPE error.
-- Reject inconsistent storage types before changing authoritative state.
if not validType(KEYS[3], 'hash') or
   (ARGV[8] ~= '' and not validType(KEYS[4], 'list')) or
   (ARGV[9] ~= '' and not validType(KEYS[5], 'list')) or
   (ARGV[12] and ARGV[12] ~= '' and (not validType(KEYS[6], 'string') or not validType(KEYS[7], 'set'))) then
  return redis.error_reply('Agent runtime storage type mismatch')
end
local previousJson = redis.call('GET', KEYS[2])
if previousJson then
  local previous = cjson.decode(previousJson)
  local previousStep = tonumber(previous.stepCount)
  local nextStep = tonumber(ARGV[7])
  local leaseStep = tonumber(ARGV[10])
  if not previousStep or not nextStep then return 0 end
  if nextStep < previousStep or previousStep > leaseStep + 1 then return 0 end
  if ARGV[11] == '1' and previousStep ~= leaseStep then return 0 end
end
redis.call('SETEX', KEYS[2], ARGV[2], ARGV[3])
redis.call('HSET', KEYS[3], 'lastActiveAt', ARGV[4], 'status', ARGV[5], 'totalCost', ARGV[6], 'totalSteps', ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[2])
if ARGV[8] ~= '' then
  redis.call('LPUSH', KEYS[4], ARGV[8])
  redis.call('LTRIM', KEYS[4], 0, 199)
  redis.call('EXPIRE', KEYS[4], ARGV[2])
end
if ARGV[9] ~= '' then
  redis.call('LPUSH', KEYS[5], ARGV[9])
  redis.call('LTRIM', KEYS[5], 0, 199)
  redis.call('EXPIRE', KEYS[5], ARGV[2])
end
if ARGV[12] and ARGV[12] ~= '' then
  redis.call('SET', KEYS[6], ARGV[12])
  redis.call('SADD', KEYS[7], KEYS[6])
end
return 1
`;

export interface StepLeaseRenewalOptions {
  intervalMs?: number;
  lease: StepLease;
  onLost?: (error: StepLeaseLostError) => void;
  renew: (lease: StepLease, ttlSeconds: number) => Promise<boolean>;
  /** Wall-clock time recorded BEFORE acquisition, not when its response arrives. */
  startedAt: number;
  timeoutMs?: number;
  ttlSeconds?: number;
}

/**
 * Conservative local ownership guard. A timed-out Redis command may still execute,
 * but can never revive this controller. No guard can undo external side effects.
 */
export const startStepLeaseRenewal = (options: StepLeaseRenewalOptions) => {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STEP_LEASE_TTL_SECONDS;
  const ttlMs = stepLeaseTtlMs(ttlSeconds);
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(options.startedAt) || options.startedAt > Date.now()) {
    throw new RangeError('Step lease start time must not be in the future');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= ttlMs) {
    throw new RangeError('Step lease renewal interval must be shorter than its TTL');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) {
    throw new RangeError('Step lease renewal timeout must be between 0 and 5000ms');
  }
  const controller = new AbortController();
  let deadline = options.startedAt + ttlMs;
  let stopped = false;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const clearTimers = () => {
    clearTimeout(renewalTimer);
    clearTimeout(expiryTimer);
  };
  const lose = (cause?: unknown): StepLeaseLostError => {
    if (!controller.signal.aborted) {
      const error = new StepLeaseLostError(cause);
      clearTimers();
      controller.abort(error);
      try {
        options.onLost?.(error);
      } catch {
        // Observers cannot prevent abort or turn a lost lease into a held lease.
      }
    }
    return controller.signal.reason as StepLeaseLostError;
  };
  const assertHeld = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (stopped) throw new StepLeaseLostError();
    if (Date.now() >= deadline) throw lose();
  };
  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    clearTimers();
    expiryTimer = setTimeout(() => lose(), Math.max(0, deadline - Date.now()));
    renewalTimer = setTimeout(() => void renewNow().catch(() => {}), intervalMs);
  };
  const renewNow = (): Promise<void> => {
    try {
      assertHeld();
    } catch (error) {
      return Promise.reject(error);
    }
    if (inFlight) return inFlight;
    const startedAt = Date.now();
    const attempt = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const renewed = await Promise.race([
          Promise.resolve().then(() => options.renew(options.lease, ttlSeconds)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new StepLeaseLostError()),
              Math.min(timeoutMs, deadline - startedAt),
            );
          }),
        ]);
        if (stopped) return;
        assertHeld();
        if (!renewed || Date.now() - startedAt >= timeoutMs) throw lose();
        // Count TTL from the request start, never from its delayed response.
        deadline = startedAt + ttlMs;
        schedule();
      } catch (error) {
        throw lose(error);
      } finally {
        clearTimeout(timeout);
        inFlight = undefined;
      }
    };
    inFlight = attempt();
    return inFlight;
  };
  if (Date.now() >= deadline) lose();
  else schedule();

  return {
    assertHeld,
    renewNow,
    signal: controller.signal,
    stop: async (): Promise<void> => {
      stopped = true;
      clearTimers();
      // Renewal races a <=5s timeout, so cleanup cannot wait indefinitely.
      await inFlight?.catch(() => {});
    },
  };
};
