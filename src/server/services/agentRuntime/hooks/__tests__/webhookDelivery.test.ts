// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverWebhook, WEBHOOK_FETCH_TIMEOUT_MS, WebhookDeliveryError } from '../webhookDelivery';

const destination = 'https://recipient.test/secret-token';
const payload = { hookId: 'hook', hookType: 'onComplete', operationId: 'op' };

describe('webhook delivery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('QSTASH_TOKEN', 'fake-test-token');
    vi.stubEnv('QSTASH_URL', 'https://qstash.test');
    vi.stubEnv('QSTASH_DEV', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('uses a single bounded POST, rejects redirects, and releases the unread body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 204,
      body: { cancel },
    } as unknown as Response);
    vi.useFakeTimers();

    await deliverWebhook({ url: destination }, payload);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(destination, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([302, 401, 500])(
    'rejects HTTP %i without reading or echoing its body',
    async (status) => {
      const text = vi.fn().mockResolvedValue('secret response body');
      vi.mocked(fetch).mockResolvedValue({ ok: false, status, text } as unknown as Response);
      await expect(deliverWebhook({ url: destination }, payload)).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        message: 'HTTP_ERROR',
        status,
      });
      expect(text).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('aborts a stalled request and reports an ambiguous timeout without retrying', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('secret abort detail')));
        }),
    );
    const result = deliverWebhook({ url: destination }, payload);
    const assertion = expect(result).rejects.toMatchObject({
      code: 'FETCH_TIMEOUT',
      message: 'FETCH_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(WEBHOOK_FETCH_TIMEOUT_MS);
    await assertion;
    expect(vi.mocked(fetch).mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry unknown network or redirect failures or expose their details', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`failed at ${destination}`));
    const result = deliverWebhook({ url: destination }, payload);
    await expect(result).rejects.toBeInstanceOf(WebhookDeliveryError);
    await expect(result).rejects.toMatchObject({ code: 'FETCH_FAILED', message: 'FETCH_FAILED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fences QStash publication when ownership expires during its asynchronous import', async () => {
    let held = true;
    const leaseError = new Error('lease lost during import');
    const assertStepLease = () => {
      if (!held) throw leaseError;
    };

    const delivery = deliverWebhook(
      { delivery: 'qstash', url: destination },
      payload,
      assertStepLease,
    );
    // Dynamic import yields even when the SDK module has already been loaded.
    held = false;

    await expect(delivery).rejects.toBe(leaseError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'qstash'] as const)(
    'does not sanitize ownership loss into a %s delivery failure',
    async (delivery) => {
      let held = true;
      const leaseError = new Error('lease lost during delivery');
      const assertStepLease = () => {
        if (!held) throw leaseError;
      };
      vi.mocked(fetch).mockImplementation(async () => {
        held = false;
        return new Response('secret error body', { status: 401 });
      });

      await expect(
        deliverWebhook({ delivery, url: destination }, payload, assertStepLease),
      ).rejects.toBe(leaseError);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('fails closed when QStash has no token', async () => {
    vi.stubEnv('QSTASH_TOKEN', '');
    await expect(
      deliverWebhook({ delivery: 'qstash', url: destination }, payload),
    ).rejects.toMatchObject({
      code: 'QSTASH_TOKEN_MISSING',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // Use the installed SDK with a stubbed transport to verify its real retry/dedup behavior.
  it('bounds QStash network retries to three attempts with one deduplication ID', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`unknown publish outcome ${destination}`));
    await expect(
      deliverWebhook({ delivery: 'qstash', url: destination }, payload),
    ).rejects.toMatchObject({
      code: 'QSTASH_PUBLISH_FAILED',
      message: 'QSTASH_PUBLISH_FAILED',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    const ids = vi.mocked(fetch).mock.calls.map(([url, init]) => {
      expect(String(url)).toMatch(/^https:\/\/qstash\.test\/v2\/publish\//);
      const headers = new Headers(init!.headers);
      expect(headers.get('authorization')).toBe('Bearer fake-test-token');
      return headers.get('Upstash-Deduplication-Id');
    });
    expect(ids[0]).toBeTruthy();
    expect(new Set(ids).size).toBe(1);
  });

  it('does not retry a QStash HTTP rejection or fallback to recipient fetch', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('secret provider body', { status: 401 }));
    await expect(
      deliverWebhook({ delivery: 'qstash', url: destination }, payload),
    ).rejects.toMatchObject({
      code: 'QSTASH_PUBLISH_FAILED',
      message: 'QSTASH_PUBLISH_FAILED',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/^https:\/\/qstash\.test\//);
  });

  it('accepts successful SDK retry but does not deduplicate later legitimate identical events', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('ambiguous publication failure'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'published' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'another-publication' })));
    await deliverWebhook({ delivery: 'qstash', url: destination }, payload);
    await deliverWebhook({ delivery: 'qstash', url: destination }, payload);
    expect(fetch).toHaveBeenCalledTimes(3);
    const ids = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => new Headers(init!.headers).get('Upstash-Deduplication-Id'));
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
