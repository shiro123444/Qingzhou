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
  it('restores confirmed transport receipts without sending the same native effect twice', async () => {
    const ledger = new InMemoryCallbackLedger();
    const original = { streamId: 'stream-1', index: 0, final: false };
    const send = vi.fn().mockResolvedValue(original);
    const first = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    const receipt = await first.effectWithReceipt<typeof original>('qq-stream', send);
    receipt.index = 99;
    original.streamId = 'mutated-by-caller';
    await first.release();

    const resumed = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    expect(await resumed.effectWithReceipt('qq-stream', send)).toEqual({
      streamId: 'stream-1',
      index: 0,
      final: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const entries = resumed.transportReceiptEntries<typeof original>();
    entries[0].value.index = 100;
    expect(resumed.transportReceiptEntries<typeof original>()[0].value.index).toBe(0);
    await resumed.release();
  });

  it('retains confirmed native transport state after completing one step and starting another', async () => {
    const ledger = new InMemoryCallbackLedger();
    const first = (await CallbackDeliverySession.begin(
      { ...body, type: 'step' },
      'step-1',
      ledger,
    ))!;
    await first.plan({ mode: 'native', content: 'private text' });
    await first.effectWithReceipt('qq-stream', async () => ({
      streamId: 'stream-1',
      index: 0,
      final: false,
    }));
    await first.complete();
    await first.release();

    const next = (await CallbackDeliverySession.begin(
      { ...body, type: 'step', stepIndex: 2 },
      'step-2',
      ledger,
    ))!;
    expect(next.transportReceiptEntries()).toEqual([
      {
        key: 'step:1/qq-stream',
        value: { streamId: 'stream-1', index: 0, final: false },
      },
    ]);
    const stored = next.transportReceiptEntries();
    expect(JSON.stringify(stored)).not.toContain('private text');
    await next.release();
  });

  it('keeps a live stream draft across steps and redacts its content at final completion', async () => {
    const ledger = new InMemoryCallbackLedger();
    const step = (await CallbackDeliverySession.begin({ ...body, type: 'step' }, 'step', ledger))!;
    await step.effectWithReceipt('qq-stream', async () => ({
      streamId: 'stream-1',
      index: 0,
      content: 'private draft',
      final: false,
    }));
    await step.complete();
    await step.release();
    const final = (await CallbackDeliverySession.begin(body, 'final', ledger))!;
    expect(final.transportReceiptEntries<{ content: string }>('qq-stream')[0].value.content).toBe(
      'private draft',
    );
    await final.effectWithReceipt('qq-stream', async () => ({
      streamId: 'stream-1',
      index: 1,
      content: 'private complete answer',
      final: true,
    }));
    await final.complete({ redactReceiptFields: ['content'] });
    expect(final.transportReceiptEntries('qq-stream')).toEqual([
      { key: 'step:1/qq-stream', value: { streamId: 'stream-1', index: 0, final: false } },
      { key: 'completion/qq-stream', value: { streamId: 'stream-1', index: 1, final: true } },
    ]);
    await final.release();
    const stored = await ledger.acquire(callbackScopeKey(body), 'inspector');
    expect(JSON.stringify(stored)).not.toContain('private');
    expect(stored?.events.completion.delivered).toBe(true);
    expect(stored?.transportReceipts?.['completion/qq-stream']).toMatchObject({
      streamId: 'stream-1',
      index: 1,
    });
    await ledger.release(callbackScopeKey(body), 'inspector');
  });

  it('rejects a missing earlier stream receipt after manual delivered reconciliation', async () => {
    const ledger = new InMemoryCallbackLedger();
    const step = (await CallbackDeliverySession.begin({ ...body, type: 'step' }, 'step', ledger))!;
    await step.effect('qq-stream', async () => {});
    await step.complete();
    await step.release();
    const next = (await CallbackDeliverySession.begin(
      { ...body, type: 'step', stepIndex: 2 },
      'next',
      ledger,
    ))!;
    await next.effectWithReceipt('reply-card', async () => ({ cardId: 'card-1' }));
    expect(next.transportReceiptEntries('reply-card')).toEqual([
      { key: 'step:2/reply-card', value: { cardId: 'card-1' } },
    ]);
    expect(() => next.transportReceiptEntries('qq-stream')).toThrow('payload_conflict');
    await next.release();
  });

  it('quarantines a native send when saving its acknowledged receipt fails', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    const save = ledger.save.bind(ledger);
    let saves = 0;
    vi.spyOn(ledger, 'save').mockImplementation(async (...args) => {
      saves++;
      if (saves === 2) throw new Error('receipt confirmation unavailable');
      await save(...args);
    });
    const send = vi.fn().mockResolvedValue({ streamId: 'stream-1', index: 0 });
    await expect(session.effectWithReceipt('qq-stream', send)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    expect(session.transportReceiptEntries()).toEqual([]);
    await expect(session.effectWithReceipt('qq-stream', send)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    await session.release();
    await expect(CallbackDeliverySession.begin(body, 'native', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not reconstruct a missing receipt by resending an old delivered effect', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    await session.effect('qq-stream', async () => {});
    const send = vi.fn();
    await expect(session.effectWithReceipt('qq-stream', send)).rejects.toMatchObject({
      status: 'payload_conflict',
    });
    expect(send).not.toHaveBeenCalled();
    await session.release();
  });

  it('keeps a platform acknowledgement without a JSON receipt uncertain', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    await expect(
      session.effectWithReceipt('qq-stream', async () => undefined),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
    expect(session.transportReceiptEntries()).toEqual([]);
    await session.release();
    await expect(CallbackDeliverySession.begin(body, 'native', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
  });

  it('does not expose a late receipt after a timed-out native send', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    let finish!: (value: { streamId: string }) => void;
    let entered!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const effect = session.effectWithReceipt('qq-stream', () => {
      entered();
      return new Promise<{ streamId: string }>((resolve) => {
        finish = resolve;
      });
    });
    const rejected = expect(effect).rejects.toMatchObject({ status: 'unknown_delivery' });
    await sending;
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    finish({ streamId: 'late-stream' });
    await Promise.resolve();
    expect(session.transportReceiptEntries()).toEqual([]);
    await session.release();
    await expect(CallbackDeliverySession.begin(body, 'native', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
  });

  it('peeks only the original frozen presentation after dispatch and rejects a missing plan', async () => {
    const ledger = new InMemoryCallbackLedger();
    const session = (await CallbackDeliverySession.begin(body, 'native', ledger))!;
    expect(session.frozenPlan()).toBeUndefined();
    await session.plan({ mode: 'native', content: 'first' });
    expect(session.frozenPlan()).toBeUndefined();
    await session.effect('qq-stream', async () => {});
    const frozen = session.frozenPlan<{ mode: string; content: string }>()!;
    frozen.content = 'changed';
    expect(session.frozenPlan()).toEqual({ mode: 'native', content: 'first' });
    await session.release();

    const missing = (await CallbackDeliverySession.begin(
      { ...body, operationId: 'legacy' },
      'native',
      ledger,
    ))!;
    await missing.effect('qq-stream', async () => {});
    expect(() => missing.frozenPlan()).toThrow('payload_conflict');
    await missing.release();
  });

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
    let notifySending!: () => void;
    const sending = new Promise<void>((resolve) => {
      notifySending = resolve;
    });
    const sent = step.effect(
      'edit',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          notifySending();
        }),
    );
    const rejected = expect(sent).rejects.toMatchObject({ status: 'unknown_delivery' });
    await sending;
    vi.setSystemTime(Date.now() + CALLBACK_LEASE_MS + 1);
    await expect(CallbackDeliverySession.begin(body, 'completion', ledger)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    finish();
    await rejected;
    await step.release();
    const stored = await ledger.acquire(callbackScopeKey(body), 'inspector');
    expect(stored?.effects['step:1/edit']).toBe('unknown_delivery');
    await ledger.release(callbackScopeKey(body), 'inspector');
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
