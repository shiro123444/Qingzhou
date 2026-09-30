import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { LarkAdapter } from './adapter';
import type { LarkAdapterConfig } from './types';
import { authenticateLarkWebhook } from './webhook-security';

const config: LarkAdapterConfig = {
  appId: 'cli_security',
  appSecret: 'secret',
  encryptKey: 'encrypt_key',
  platform: 'feishu',
  verificationToken: 'token',
};
const event = { header: { app_id: config.appId, event_type: 'ignored', token: 'token' } };
const challenge = { challenge: 'challenge', token: 'token', type: 'url_verification' };
const plain = (body: unknown) =>
  new Request('http://localhost/webhook', {
    body: JSON.stringify(body),
    method: 'POST',
  });
function signed(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const request = plain(body);
  const nonce = randomBytes(16).toString('hex');
  request.headers.set('X-Lark-Request-Timestamp', timestamp);
  request.headers.set('X-Lark-Request-Nonce', nonce);
  request.headers.set(
    'X-Lark-Signature',
    createHash('sha256')
      .update(timestamp + nonce + config.encryptKey + JSON.stringify(body))
      .digest('hex'),
  );
  return request;
}
function encrypted(body: unknown) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    'aes-256-cbc',
    createHash('sha256').update(config.encryptKey!).digest(),
    iv,
  );
  return {
    encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(body)), cipher.final()]).toString(
      'base64',
    ),
  };
}
async function status(request: Request, overrides: Partial<LarkAdapterConfig> = {}) {
  const result = await authenticateLarkWebhook(request, { ...config, ...overrides });
  return result instanceof Response ? result.status : 200;
}

describe('native webhook security', () => {
  it('rejects unsigned events even with a valid static token', async () => {
    expect(await status(plain(event))).toBe(401);
    expect(await status(plain(event), { encryptKey: undefined })).toBe(503);
    expect(
      await status(plain(event), { encryptKey: undefined, verificationToken: undefined }),
    ).toBe(503);
  });
  it('rejects fabricated, changed-body, wrong-app and wrong-token signatures', async () => {
    const fake = signed(event);
    fake.headers.set('X-Lark-Signature', '0'.repeat(64));
    expect(await status(fake)).toBe(401);
    const original = signed(event);
    const changed = new Request(original.url, {
      body: JSON.stringify({ ...event, extra: true }),
      headers: original.headers,
      method: 'POST',
    });
    expect(await status(changed)).toBe(401);
    expect(await status(signed({ header: { ...event.header, app_id: 'other' } }))).toBe(401);
    expect(await status(signed({ header: { ...event.header, app_id: undefined } }))).toBe(401);
    expect(await status(signed({ header: { ...event.header, token: 'wrong' } }))).toBe(401);
  });
  it('rejects old/future timestamps and malformed signature metadata', async () => {
    for (const offset of [-301, 301]) {
      expect(await status(signed(event, String(Math.floor(Date.now() / 1000) + offset)))).toBe(401);
    }
    for (const [name, value] of [
      ['X-Lark-Request-Timestamp', '1e9'],
      ['X-Lark-Request-Nonce', ''],
      ['X-Lark-Signature', 'not-hex'],
    ]) {
      const request = signed(event);
      request.headers.set(name, value);
      expect(await status(request)).toBe(401);
    }
  });
  it('rejects replay atomically and scopes claims to platform/application', async () => {
    const request = signed(event);
    const clone = request.clone();
    expect(await status(request)).toBe(200);
    expect(await status(clone)).toBe(409);
    const claimWebhookReplay = vi.fn().mockResolvedValue(true);
    expect(await status(signed(event), { claimWebhookReplay })).toBe(200);
    expect(claimWebhookReplay).toHaveBeenCalledWith(
      expect.stringMatching(/^lark-webhook:feishu:cli_security:/),
      601,
    );
    expect(await status(signed(event), { claimWebhookReplay: async () => false })).toBe(409);
    expect(
      await status(signed(event), {
        claimWebhookReplay: async () => {
          throw new Error('Redis secret');
        },
      }),
    ).toBe(503);
  });
  it('accepts correctly signed native encrypted events and challenge', async () => {
    expect(await authenticateLarkWebhook(signed(encrypted(event)), config)).toEqual(event);
    const result = await authenticateLarkWebhook(signed(encrypted(challenge)), config);
    expect(result).toBeInstanceOf(Response);
    expect(await (result as Response).json()).toEqual({ challenge: 'challenge' });
  });
  it('authenticates before trying decryption', async () => {
    const result = await authenticateLarkWebhook(plain({ encrypt: 'garbage' }), config);
    expect((result as Response).status).toBe(401);
    expect(await (result as Response).text()).toBe('Invalid webhook signature metadata');
  });
  it('supports only authenticated token-only URL registration, never dispatch', async () => {
    for (const encryptKey of [undefined, 'encrypt_key']) {
      expect(await status(plain(challenge), { encryptKey })).toBe(200);
      expect(await status(plain({ ...challenge, token: 'wrong' }), { encryptKey })).not.toBe(200);
    }
    expect(
      await status(plain(challenge), { encryptKey: undefined, verificationToken: undefined }),
    ).toBe(503);
    const processMessage = vi.fn();
    const adapter = new LarkAdapter(config);
    (adapter as any).chat = { processMessage };
    const result = await adapter.handleWebhook(plain({ ...event, ...challenge }));
    expect(result.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
  });
  it.each(['X-Lark-Request-Timestamp', 'X-Lark-Request-Nonce', 'X-Lark-Signature'])(
    'rejects token-only challenge downgrade with a partial %s header',
    async (header) => {
      const request = plain(challenge);
      request.headers.set(header, 'invalid');
      expect(await status(request)).toBe(401);
    },
  );

  it('rejects a bad native signature on a challenge even with the correct token', async () => {
    const request = signed(challenge);
    request.headers.set('X-Lark-Signature', '0'.repeat(64));
    expect(await status(request)).toBe(401);
  });

  it('does not let forged internal headers bypass native auth', async () => {
    const request = plain(event);
    request.headers.set('x-qingzhou-gateway-signature', '0'.repeat(64));
    expect(await status(request)).toBe(401);
  });
  it('times out and cancels an unterminated slow body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    try {
      const request = new Request('http://localhost', {
        body: new ReadableStream({ cancel }),
        duplex: 'half',
        method: 'POST',
      } as RequestInit);
      const result = status(request);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toBe(400);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces POST, payload shape and actual body size without trusting Content-Length', async () => {
    expect(await status(new Request('http://localhost'))).toBe(405);
    expect(await status(plain(null))).toBe(400);
    expect(await status(plain([]))).toBe(400);
    expect(await status(plain('x'.repeat(1024 * 1024)))).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    const request = new Request('http://localhost', {
      body: stream,
      duplex: 'half',
      headers: { 'Content-Length': '1' },
      method: 'POST',
    } as RequestInit);
    expect(await status(request)).toBe(413);
  });
});

describe('trusted internal webhook callback', () => {
  it('calls authentication first and accepts internal WS envelopes without native keys/tokens', async () => {
    const authenticateWebhook = vi.fn(async (request: Request) => {
      expect(await request.clone().json()).toEqual(event);
    });
    expect(
      await status(plain(event), {
        authenticateWebhook,
        encryptKey: undefined,
        verificationToken: undefined,
      }),
    ).toBe(200);
    expect(authenticateWebhook).toHaveBeenCalledOnce();
  });
  it('never falls back on callback rejection or throw even with valid native signature/challenge', async () => {
    expect(
      await status(signed(event), {
        authenticateWebhook: async () => new Response('Denied', { status: 401 }),
      }),
    ).toBe(401);
    expect(
      await status(plain(challenge), {
        authenticateWebhook: async () => {
          throw new Error('secret');
        },
      }),
    ).toBe(503);
    expect(await status(plain(challenge), { authenticateWebhook: async () => {} })).toBe(400);
  });
});
