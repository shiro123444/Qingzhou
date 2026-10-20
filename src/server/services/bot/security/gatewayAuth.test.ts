// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as redisRuntime from '@/server/modules/AgentRuntime/redis';

import {
  claimWebhookReplay,
  createGatewayAuthenticator,
  GATEWAY_AUTH_HEADERS,
  MAX_GATEWAY_BODY_BYTES,
  signGatewayRequest,
} from './gatewayAuth';

const scope = { applicationId: 'app-a', platform: 'wechat', secret: 'test-only-bot-secret' };
const url = 'https://qingzhou.example/api/agent/webhooks/wechat/app-a';
const body = JSON.stringify({ from_user_id: 'alice', text: '你好' });
const signed = () => signGatewayRequest({ ...scope, body, url });

afterEach(() => vi.restoreAllMocks());

describe('gateway authentication envelope', () => {
  it('authenticates exact UTF-8 bytes without consuming the adapter body or sending secrets', async () => {
    const claimReplay = vi.fn(async () => true);
    const init = signed();
    const request = new Request(url, init);
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).not.toContain(scope.secret);
    await expect(
      createGatewayAuthenticator({ ...scope, claimReplay })(request),
    ).resolves.toBeUndefined();
    expect(await request.text()).toBe(body);
    expect(claimReplay).toHaveBeenCalledWith(expect.stringContaining('app-a'), 601);
  });

  it.each([{ applicationId: 'other-app' }, { platform: 'qq' }, { secret: 'other-secret' }])(
    'rejects a different installation identity or credential: %j',
    async (override) => {
      const claimReplay = vi.fn(async () => true);
      const result = await createGatewayAuthenticator({ ...scope, ...override, claimReplay })(
        new Request(url, signed()),
      );
      expect(result?.status).toBe(401);
      expect(claimReplay).not.toHaveBeenCalled();
    },
  );

  it.each([
    { body: `${body} `, target: url },
    { body, target: `${url}/other` },
    { body, target: `${url}?different=1` },
  ])('rejects changed body or target: %j', async ({ body: changed, target }) => {
    const claimReplay = vi.fn(async () => true);
    const request = new Request(target, { ...signed(), body: changed });
    expect((await createGatewayAuthenticator({ ...scope, claimReplay })(request))?.status).toBe(
      401,
    );
    expect(claimReplay).not.toHaveBeenCalled();
  });

  it.each(Object.values(GATEWAY_AUTH_HEADERS))('requires %s', async (header) => {
    const init = signed();
    const headers = new Headers(init.headers);
    headers.delete(header);
    const auth = createGatewayAuthenticator({ ...scope, claimReplay: async () => true });
    expect((await auth(new Request(url, { ...init, headers })))?.status).toBe(401);
  });

  it.each(['', 'zz'.repeat(32), 'aa', 'a'.repeat(1000)])(
    'rejects malformed signatures (%s)',
    async (signature) => {
      const init = signed();
      const headers = new Headers(init.headers);
      headers.set(GATEWAY_AUTH_HEADERS.signature, signature);
      const auth = createGatewayAuthenticator({ ...scope, claimReplay: async () => true });
      expect((await auth(new Request(url, { ...init, headers })))?.status).toBe(401);
    },
  );

  it.each([-301_000, 301_000])('rejects stale or future timestamps with skew %i', async (skew) => {
    const now = Date.now();
    const auth = createGatewayAuthenticator({
      ...scope,
      claimReplay: async () => true,
      now: () => now + skew,
    });
    expect((await auth(new Request(url, signed())))?.status).toBe(401);
  });

  it('rejects non-POST methods before processing', async () => {
    const auth = createGatewayAuthenticator({ ...scope, claimReplay: async () => true });
    expect((await auth(new Request(url, { headers: signed().headers })))?.status).toBe(405);
  });

  it('rejects replay across verifier instances with a shared atomic store', async () => {
    const keys = new Set<string>();
    const claimReplay = async (key: string) => {
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    };
    const init = signed();
    const a = createGatewayAuthenticator({ ...scope, claimReplay });
    const b = createGatewayAuthenticator({ ...scope, claimReplay });
    const results = await Promise.all([a(new Request(url, init)), b(new Request(url, init))]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results.find((result) => result !== undefined)?.status).toBe(409);
  });

  it('fails closed and redacts replay-store failures', async () => {
    const auth = createGatewayAuthenticator({
      ...scope,
      claimReplay: async () => {
        throw new Error('redis://secret');
      },
    });
    const response = await auth(new Request(url, signed()));
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain('redis://secret');
  });

  it('rejects oversized actual streamed bodies even with a forged small Content-Length', async () => {
    const init = signed();
    const headers = new Headers(init.headers);
    headers.set('content-length', '1');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_GATEWAY_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request(url, {
      ...init,
      body: stream,
      duplex: 'half',
      headers,
    } as RequestInit);
    const claimReplay = vi.fn(async () => true);
    expect((await createGatewayAuthenticator({ ...scope, claimReplay })(request))?.status).toBe(
      413,
    );
    expect(claimReplay).not.toHaveBeenCalled();
  });

  it('times out a stalled body without claiming or dispatching the request', async () => {
    vi.useFakeTimers();
    try {
      const claimReplay = vi.fn(async () => true);
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      const request = new Request(url, {
        ...signed(),
        body: stream,
        duplex: 'half',
      } as RequestInit);
      const response = createGatewayAuthenticator({ ...scope, claimReplay })(request);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await response)?.status).toBe(400);
      expect(claimReplay).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cannot be forged by using the public application ID as the signing secret', async () => {
    const forged = signGatewayRequest({ ...scope, body, secret: scope.applicationId, url });
    expect(
      (
        await createGatewayAuthenticator({ ...scope, claimReplay: async () => true })(
          new Request(url, forged),
        )
      )?.status,
    ).toBe(401);
  });

  it('uses a purpose-separated key rather than platform protocol signatures', () => {
    const init = signed();
    const headers = new Headers(init.headers);
    const nonce = headers.get(GATEWAY_AUTH_HEADERS.nonce)!;
    const timestamp = headers.get(GATEWAY_AUTH_HEADERS.timestamp)!;
    const hash = createHash('sha256').update(body).digest('hex');
    const canonical = JSON.stringify([
      'qingzhou.bot.gateway.v1',
      scope.platform,
      scope.applicationId,
      'POST',
      new URL(url).pathname,
      timestamp,
      nonce,
      hash,
    ]);
    const directKeySignature = createHmac('sha256', scope.secret).update(canonical).digest('hex');
    expect(headers.get(GATEWAY_AUTH_HEADERS.signature)).not.toBe(directKeySignature);
  });

  it('rejects missing secrets, credentials in URLs and oversized payloads at signing time', () => {
    expect(() => signGatewayRequest({ ...scope, body, secret: '', url })).toThrow();
    expect(() =>
      signGatewayRequest({ ...scope, body, url: 'https://secret@example.com/path' }),
    ).toThrow();
    expect(() =>
      signGatewayRequest({ ...scope, body: 'a'.repeat(MAX_GATEWAY_BODY_BYTES + 1), url }),
    ).toThrow();
  });
});

describe('production replay claims', () => {
  it('uses atomic NX/EX and hashed namespaced keys in shared Redis', async () => {
    const set = vi.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue({ set } as never);
    expect(await claimWebhookReplay('wechat:app:nonce', 601)).toBe(true);
    expect(await claimWebhookReplay('wechat:app:nonce', 601)).toBe(false);
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^bot:webhook:replay:v1:[\da-f]{64}$/u),
      '1',
      'EX',
      601,
      'NX',
    );
  });

  it('bounds a stalled Redis claim rather than hanging authenticated ingress', async () => {
    vi.useFakeTimers();
    try {
      const set = vi.fn(() => new Promise(() => {}));
      vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue({ set } as never);
      const rejected = expect(claimWebhookReplay('key', 601)).rejects.toThrow('timed out');
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(2001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not use a process-local fallback when Redis is absent', async () => {
    vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue(null);
    await expect(claimWebhookReplay('key', 601)).rejects.toThrow('unavailable');
  });
});
