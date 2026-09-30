// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

import {
  CALLBACK_LEASE_MS,
  CALLBACK_LEDGER_SCRIPT,
  CALLBACK_REDIS_TIMEOUT_MS,
  CallbackDeliverySession,
  callbackScopeKey,
  getCallbackLedger,
  InMemoryCallbackLedger,
  RedisCallbackLedger,
} from '../callbackLedger';

vi.mock('@/server/modules/AgentRuntime/redis', () => ({ getAgentRuntimeRedisClient: vi.fn() }));
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: vi.fn() }));

const body = {
  applicationId: 'app',
  operationId: 'op',
  platformThreadId: 'telegram:thread',
  stepIndex: 1,
  type: 'completion' as const,
  userId: 'user',
};

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('callback delivery ledger', () => {
  it('isolates app/user/installation/platform and does not conflate installation and app', () => {
    const variants = [
      body,
      { ...body, applicationId: 'other' },
      { ...body, userId: 'other' },
      { ...body, messengerInstallationKey: 'app' },
      { ...body, messengerInstallationKey: 'other' },
      { ...body, platformThreadId: 'discord:thread' },
      { ...body, operationId: 'other' },
    ];
    expect(new Set(variants.map(callbackScopeKey)).size).toBe(variants.length);
  });

  it('uses shared local storage explicitly and fails closed without queue Redis', () => {
    vi.mocked(isQueueAgentRuntimeEnabled).mockReturnValue(false);
    expect(getCallbackLedger()).toBe(getCallbackLedger());
    vi.mocked(isQueueAgentRuntimeEnabled).mockReturnValue(true);
    vi.mocked(getAgentRuntimeRedisClient).mockReturnValue(null);
    expect(() => getCallbackLedger()).toThrow('backend_unavailable');
  });

  it('rejects missing operation and invalid step index', async () => {
    const ledger = new InMemoryCallbackLedger();
    await expect(
      CallbackDeliverySession.begin({ ...body, operationId: undefined }, 'p', ledger),
    ).rejects.toMatchObject({ status: 'invalid_callback' });
    await expect(
      CallbackDeliverySession.begin({ ...body, type: 'step', stepIndex: undefined }, 'p', ledger),
    ).rejects.toMatchObject({ status: 'invalid_callback' });
  });

  it('serializes an operation and skips completion after successful confirmation', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'busy',
    });
    await session.effect('chunk:0', async () => {});
    await session.complete();
    await session.release();
    expect(await CallbackDeliverySession.begin(body, 'different hook/reason', ledger)).toBeNull();
    expect(
      await CallbackDeliverySession.begin({ ...body, type: 'step', stepIndex: 99 }, 'late', ledger),
    ).toBeNull();
  });

  it('skips an out-of-order step without editing progress', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(
      { ...body, type: 'step', stepIndex: 2 },
      'p',
      ledger,
    ))!;
    await session.complete();
    await session.release();
    expect(
      await CallbackDeliverySession.begin({ ...body, type: 'step', stepIndex: 1 }, 'p', ledger),
    ).toBeNull();
  });

  it('resumes only unsent chunks using the frozen rendered plan', async () => {
    const ledger = new InMemoryCallbackLedger();
    const send = vi.fn().mockResolvedValue(undefined);
    const first = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await first.plan(['one', 'two']);
    await first.effect('chunk:0', send);
    // A failure before dispatching the next effect is safe to resume.
    await first.release();
    const second = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    expect(await second.plan(['one', 'changed'])).toEqual(['one', 'two']);
    await second.plan(['one', 'two']);
    await second.effect('chunk:0', send);
    expect(send).toHaveBeenCalledTimes(1);
    await second.effect('chunk:1', send);
    expect(send).toHaveBeenCalledTimes(2);
    await second.complete();
    await second.release();
  });

  it('permits replacing a plan before any message effect, but freezes stable intent after dispatch', async () => {
    const ledger = new InMemoryCallbackLedger();
    const first = (await CallbackDeliverySession.begin(body, 'original-intent', ledger))!;
    await first.plan(['original-render']);
    await first.release();
    const refreshed = (await CallbackDeliverySession.begin(body, 'updated-intent', ledger))!;
    expect(await refreshed.plan(['updated-render'])).toEqual(['updated-render']);
    await refreshed.effect('chunk:0', async () => {});
    await refreshed.release();
    await expect(
      CallbackDeliverySession.begin(body, 'different-content', ledger),
    ).rejects.toMatchObject({ status: 'payload_conflict' });
  });

  it('drops completed rendered text but retains partial/unknown plans and durable hashes', async () => {
    const ledger = new InMemoryCallbackLedger();
    const first = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await first.plan(['sensitive first', 'sensitive second']);
    await first.effect('chunk:0', async () => {});
    await first.release();
    let stored = await ledger.acquire(callbackScopeKey(body), 'inspector');
    expect(stored?.events.completion.renderedPlan).toEqual(['sensitive first', 'sensitive second']);
    const planHash = stored?.events.completion.plan;
    await ledger.release(callbackScopeKey(body), 'inspector');
    const resumed = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await resumed.effect('chunk:1', async () => {});
    await resumed.complete();
    await resumed.release();
    stored = await ledger.acquire(callbackScopeKey(body), 'inspector');
    expect(stored?.events.completion.renderedPlan).toBeUndefined();
    expect(stored?.events.completion.plan).toBe(planHash);
    expect(stored?.events.completion.delivered).toBe(true);
    expect(stored?.effects['completion/chunk:0']).toBe('delivered');
    await ledger.release(callbackScopeKey(body), 'inspector');

    const unknownBody = { ...body, operationId: 'unknown' };
    const unknown = (await CallbackDeliverySession.begin(unknownBody, 'p', ledger))!;
    await unknown.plan(['unconfirmed content']);
    await expect(
      unknown.effect('chunk:0', async () => {
        throw new Error('timeout');
      }),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
    await unknown.release();
    stored = await ledger.acquire(callbackScopeKey(unknownBody), 'inspector');
    expect(stored?.events.completion.renderedPlan).toEqual(['unconfirmed content']);
    expect(stored?.events.completion.delivered).not.toBe(true);
    await ledger.release(callbackScopeKey(unknownBody), 'inspector');
  });

  it('retains unknown delivery indefinitely, including after lease expiry', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    const send = vi.fn().mockRejectedValue(new Error('timeout after write'));
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    await session.release();
    vi.setSystemTime(Date.now() + 365 * 86400_000);
    await expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('renews the lease during long platform requests', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const renew = vi.spyOn(ledger, 'renew');
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await vi.advanceTimersByTimeAsync(CALLBACK_LEASE_MS * 2);
    expect(renew).toHaveBeenCalledTimes(6);
    await expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'busy',
    });
    await session.release();
  });

  it('stops dispatch after a failed heartbeat even if a later backend write could succeed', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    vi.spyOn(ledger, 'renew').mockRejectedValue(new Error('Redis offline'));
    await vi.advanceTimersByTimeAsync(CALLBACK_LEASE_MS / 3);
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toThrow('Redis offline');
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('ignores release errors without replacing an unknown delivery result', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    vi.spyOn(ledger, 'release').mockRejectedValue(new Error('cleanup offline'));
    await expect(
      (async () => {
        try {
          await session.effect('chunk:0', async () => {
            throw new Error('ambiguous');
          });
        } finally {
          await session.release();
        }
      })(),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
  });

  it('keeps a duplicate skipped even when release fails', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await session.complete();
    await session.release();
    vi.spyOn(ledger, 'release').mockRejectedValue(new Error('cleanup offline'));
    expect(await CallbackDeliverySession.begin(body, 'p', ledger)).toBeNull();
  });

  it('does not send when save confirmation arrives beyond the local lease deadline', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    vi.spyOn(ledger, 'save').mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
    });
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({ status: 'lease_lost' });
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('fences expired workers and compare-deletes only the current owner', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const old = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
    const current = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    const send = vi.fn();
    await expect(old.effect('chunk:0', send)).rejects.toMatchObject({ status: 'lease_lost' });
    await old.release();
    expect(send).not.toHaveBeenCalled();
    await expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'busy',
    });
    await current.release();
  });

  it('retains uncertain progress but permits completion in a separate message domain', async () => {
    const ledger = new InMemoryCallbackLedger();
    const step = (await CallbackDeliverySession.begin({ ...body, type: 'step' }, 'step', ledger))!;
    await expect(
      step.effect('progress-edit', async () => {
        throw new Error('timeout');
      }),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
    await step.release();
    const completion = (await CallbackDeliverySession.begin(body, 'final', ledger))!;
    expect(completion.hasUncertainProgress()).toBe(true);
    await completion.effect('chunk:0', async () => {});
    await completion.complete();
    await completion.release();
    // Do not delete or auto-confirm the old unknown just because final delivery succeeded.
    const stored = await ledger.acquire(callbackScopeKey(body), 'inspector');
    expect(stored?.effects['step:1/progress-edit']).toBe('unknown_delivery');
    expect(stored?.effects['completion/chunk:0']).toBe('delivered');
    await ledger.release(callbackScopeKey(body), 'inspector');
  });

  it('does not bypass unknown effects outside the explicitly separate progress domain', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const step = (await CallbackDeliverySession.begin({ ...body, type: 'step' }, 'p', ledger))!;
    let finish!: () => void;
    const sent = step.effect(
      'edit',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    await Promise.resolve();
    vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
    await expect(CallbackDeliverySession.begin(body, 'completion', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    finish();
    await expect(sent).rejects.toMatchObject({ status: 'lease_lost' });
    await step.release();
  });
});

describe('Redis failure and owner protocol', () => {
  it('fails closed on Redis errors instead of using local storage', async () => {
    const evalFn = vi.fn().mockRejectedValue(new Error('Redis unavailable'));
    const ledger = new RedisCallbackLedger({ eval: evalFn });
    await expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
  });

  it('bounds a hung Redis acquire to five seconds', async () => {
    vi.useFakeTimers();
    const ledger = new RedisCallbackLedger({ eval: vi.fn(() => new Promise(() => {})) });
    const result = expect(CallbackDeliverySession.begin(body, 'p', ledger)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
    await vi.advanceTimersByTimeAsync(CALLBACK_REDIS_TIMEOUT_MS);
    await result;
  });

  it('rejects a stale Redis reply even if the timeout callback has not run', async () => {
    vi.useFakeTimers();
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce([1, ''])
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
        return 1;
      })
      .mockResolvedValue(1);
    const session = (await CallbackDeliverySession.begin(
      body,
      'p',
      new RedisCallbackLedger({ eval: evalFn }),
    ))!;
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('does not accumulate heartbeat requests while Redis is hung and bounds cleanup', async () => {
    vi.useFakeTimers();
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce([1, ''])
      .mockResolvedValueOnce(1)
      .mockImplementation(() => new Promise(() => {}));
    const session = (await CallbackDeliverySession.begin(
      body,
      'p',
      new RedisCallbackLedger({ eval: evalFn }),
    ))!;
    await vi.advanceTimersByTimeAsync(CALLBACK_LEASE_MS * 3);
    expect(evalFn.mock.calls.filter((call) => call[4] === 'renew')).toHaveLength(1);
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
    expect(send).not.toHaveBeenCalled();
    const release = session.release();
    await vi.advanceTimersByTimeAsync(CALLBACK_REDIS_TIMEOUT_MS);
    await expect(release).resolves.toBeUndefined();
  });

  it('uses owner compare in Lua for writes, renewal and release, no state TTL', async () => {
    const evalFn = vi.fn().mockResolvedValueOnce([1, '']).mockResolvedValue(1);
    const ledger = new RedisCallbackLedger({ eval: evalFn });
    const session = (await CallbackDeliverySession.begin(body, 'p', ledger))!;
    await session.effect('chunk:0', async () => {});
    await session.complete();
    await session.release();
    const first = evalFn.mock.calls[0];
    expect(first[0]).toBe(CALLBACK_LEDGER_SCRIPT);
    expect(first.slice(1, 4)).toEqual([
      2,
      `bot:callback:{${callbackScopeKey(body)}}:lease`,
      `bot:callback:{${callbackScopeKey(body)}}:state`,
    ]);
    for (const call of evalFn.mock.calls) expect(call[5]).toBe(first[5]);
    const states = evalFn.mock.calls
      .filter((call) => call[4] === 'save')
      .map((call) => JSON.parse(call[7]));
    expect(states[1].effects['completion/chunk:0']).toBe('unknown_delivery');
    expect(states[2].effects['completion/chunk:0']).toBe('delivered');
    expect(CALLBACK_LEDGER_SCRIPT).toContain(
      "if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end",
    );
    expect(CALLBACK_LEDGER_SCRIPT).not.toContain("EXPIRE', KEYS[2]");
  });

  it('distinguishes Redis contention and rejects a lost owner before sending', async () => {
    const busy = new RedisCallbackLedger({ eval: vi.fn().mockResolvedValue([0]) });
    await expect(CallbackDeliverySession.begin(body, 'p', busy)).rejects.toMatchObject({
      status: 'busy',
    });
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce([1, ''])
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    const session = (await CallbackDeliverySession.begin(
      body,
      'p',
      new RedisCallbackLedger({ eval: evalFn }),
    ))!;
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({ status: 'lease_lost' });
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('never sends when write-ahead persistence fails', async () => {
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce([1, ''])
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(1);
    const session = (await CallbackDeliverySession.begin(
      body,
      'p',
      new RedisCallbackLedger({ eval: evalFn }),
    ))!;
    const send = vi.fn();
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('does not report delivered when Redis confirmation fails after sending', async () => {
    const evalFn = vi
      .fn()
      .mockResolvedValueOnce([1, ''])
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(1);
    const session = (await CallbackDeliverySession.begin(
      body,
      'p',
      new RedisCallbackLedger({ eval: evalFn }),
    ))!;
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(session.effect('chunk:0', send)).rejects.toMatchObject({
      status: 'backend_unavailable',
    });
    expect(send).toHaveBeenCalledTimes(1);
    await session.release();
  });
});
