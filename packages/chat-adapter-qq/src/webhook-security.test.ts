// @vitest-environment node
import { createPrivateKey, sign } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QQAdapter } from './adapter';
import { signWebhookResponse, verifyWebhookSignature } from './crypto';
import type { QQAdapterConfig } from './types';
import { claimReplay } from './webhook-security';

const secret = 'test_secret';
const appId = 'app';
const event = {
  d: { author: { id: 'u' }, content: 'hello', group_openid: 'g', id: 'm' },
  op: 0,
  t: 'GROUP_AT_MESSAGE_CREATE',
};
const raw = JSON.stringify(event);
let serial = 0;
let url: string;
function timestamp(offset = 0) {
  return String(Math.floor(Date.now() / 1000) + offset);
}
// Independent signing fixture (not the production signing helper).
function signature(body: string, ts: string, keySecret = secret) {
  const key = createPrivateKey({
    format: 'der',
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(keySecret.repeat(32).slice(0, 32)),
    ]),
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(ts + body), key).toString('hex');
}
function request(body = raw, overrides: Record<string, string> = {}) {
  const ts = timestamp();
  return new Request(url, {
    body,
    headers: {
      'X-Bot-Appid': appId,
      'X-Signature-Ed25519': signature(body, ts),
      'X-Signature-Timestamp': ts,
      ...overrides,
    },
    method: 'POST',
  });
}
function setup(config: Partial<QQAdapterConfig> = {}) {
  const adapter = new QQAdapter({ appId, clientSecret: secret, ...config });
  const processMessage = vi.fn();
  (adapter as any).chat = { processMessage };
  return { adapter, processMessage };
}

beforeEach(() => {
  url = `http://localhost/webhook/${++serial}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native webhook authentication', () => {
  it('accepts raw signed bytes and dispatches exactly once across adapters', async () => {
    const { adapter, processMessage } = setup();
    const body = '  ' + raw + '\n';
    expect((await adapter.handleWebhook(request(body))).status).toBe(200);
    expect(processMessage).toHaveBeenCalledOnce();
    expect((await setup().adapter.handleWebhook(request(body))).status).toBe(409);
  });

  it('rejects a replay through a different URL or percent-encoded path alias', async () => {
    const { adapter, processMessage } = setup();
    const body = JSON.stringify({ ...event, id: 'path-alias-replay' });
    const original = request(body);
    const headers = new Headers(original.headers);
    expect((await adapter.handleWebhook(original)).status).toBe(200);
    for (const alias of ['http://localhost/other', 'http://localhost/%77ebhook?alias=1']) {
      expect(
        (await adapter.handleWebhook(new Request(alias, { body, headers, method: 'POST' }))).status,
      ).toBe(409);
    }
    expect(processMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing signature', { 'X-Signature-Ed25519': '' }],
    ['short hex', { 'X-Signature-Ed25519': 'ab'.repeat(63) }],
    ['long hex', { 'X-Signature-Ed25519': 'ab'.repeat(65) }],
    ['non hex', { 'X-Signature-Ed25519': 'zz'.repeat(64) }],
    ['wrong identity', { 'X-Bot-Appid': 'another-app' }],
    ['missing identity', { 'X-Bot-Appid': '' }],
    ['missing timestamp', { 'X-Signature-Timestamp': '' }],
    ['timestamp exponent', { 'X-Signature-Timestamp': '1e9' }],
    ['timestamp suffix', { 'X-Signature-Timestamp': '1725442341abc' }],
  ])('rejects %s before dispatch', async (_label, headers) => {
    const { adapter, processMessage } = setup();
    expect((await adapter.handleWebhook(request(raw, headers))).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it.each([-301, 301])('rejects correctly signed timestamp outside window (%i)', async (offset) => {
    const ts = timestamp(offset);
    const { adapter, processMessage } = setup();
    expect(
      (
        await adapter.handleWebhook(
          request(raw, { 'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': signature(raw, ts) }),
        )
      ).status,
    ).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('rejects changed bytes and wrong signing key', async () => {
    const { adapter, processMessage } = setup();
    expect(
      (
        await adapter.handleWebhook(
          request(raw + ' ', { 'X-Signature-Ed25519': signature(raw, timestamp()) }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await adapter.handleWebhook(
          request(raw, { 'X-Signature-Ed25519': signature(raw, timestamp(), 'wrong') }),
        )
      ).status,
    ).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('claims shared replay state only after authentication, with a safe TTL', async () => {
    const claimWebhookReplay = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const { adapter, processMessage } = setup({ claimWebhookReplay });
    expect((await adapter.handleWebhook(request(raw, { 'X-Bot-Appid': 'wrong' }))).status).toBe(
      401,
    );
    expect(claimWebhookReplay).not.toHaveBeenCalled();
    expect((await adapter.handleWebhook(request())).status).toBe(200);
    expect((await adapter.handleWebhook(request())).status).toBe(409);
    expect(claimWebhookReplay).toHaveBeenCalledWith(
      expect.stringMatching(/^qq:webhook:[a-f0-9]{64}$/),
      601,
    );
    expect(processMessage).toHaveBeenCalledOnce();
  });

  it('fails closed on shared store errors without exposing secrets', async () => {
    const { adapter, processMessage } = setup({
      claimWebhookReplay: async () => {
        throw new Error('secret-redis-url');
      },
    });
    const response = await adapter.handleWebhook(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-redis-url');
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests and actually limits streamed bodies', async () => {
    const { adapter, processMessage } = setup();
    expect((await adapter.handleWebhook(new Request(url))).status).toBe(405);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const oversized = new Request(url, {
      body: stream,
      duplex: 'half',
      headers: { 'Content-Length': '1' },
      method: 'POST',
    } as RequestInit);
    expect((await adapter.handleWebhook(oversized)).status).toBe(413);
    expect(processMessage).not.toHaveBeenCalled();
  });
});

it('cancels a body stream that never finishes within five seconds', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const { adapter, processMessage } = setup();
  const stream = new ReadableStream({ cancel });
  const response = adapter.handleWebhook(
    new Request(url, {
      body: stream,
      duplex: 'half',
      method: 'POST',
    } as RequestInit),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect((await response).status).toBe(400);
  expect(cancel).toHaveBeenCalledOnce();
  expect(processMessage).not.toHaveBeenCalled();
});

describe('registration is not a signing oracle', () => {
  function challenge(plainToken: unknown, eventTs: unknown = timestamp()) {
    return new Request(url, {
      body: JSON.stringify({ d: { event_ts: eventTs, plain_token: plainToken }, op: 13 }),
      headers: { 'X-Bot-Appid': appId },
      method: 'POST',
    });
  }
  it('supports the official unsigned challenge without dispatch', async () => {
    const { adapter, processMessage } = setup();
    const ts = timestamp();
    const token = 'Arq0D5A61EgUu4OxUvOp';
    const response = await adapter.handleWebhook(challenge(token, ts));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plain_token: token, signature: signature(token, ts) });
    expect(processMessage).not.toHaveBeenCalled();
  });
  it.each([
    { 'X-Signature-Ed25519': 'ab'.repeat(64) },
    { 'X-Signature-Ed25519': '' },
    { 'X-Signature-Timestamp': '' },
    { 'X-Signature-Timestamp': '1725442341' },
    { 'X-Signature-Ed25519': 'bad', 'X-Signature-Timestamp': '1725442341' },
  ])('does not downgrade a challenge with signature headers %j', async (headers) => {
    const { adapter, processMessage } = setup();
    const req = challenge('Arq0D5A61EgUu4OxUvOp');
    for (const [key, value] of Object.entries(headers)) req.headers.set(key, value!);
    expect((await adapter.handleWebhook(req)).status).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('verifies complete signed challenges and rejects bad full signatures', async () => {
    const { adapter, processMessage } = setup();
    const ts = timestamp();
    const body = JSON.stringify({
      d: { event_ts: ts, plain_token: 'Arq0D5A61EgUu4OxUvOp' },
      op: 13,
    });
    expect(
      (
        await adapter.handleWebhook(
          request(body, { 'X-Signature-Ed25519': signature(body, ts, 'wrong') }),
        )
      ).status,
    ).toBe(401);
    expect((await adapter.handleWebhook(request(body))).status).toBe(200);
    expect((await adapter.handleWebhook(request(body))).status).toBe(409);
    expect(processMessage).not.toHaveBeenCalled();
  });

  it.each([
    raw,
    JSON.stringify(raw),
    '{}',
    'tok',
    'a'.repeat(129),
    'a'.repeat(16) + '\n',
    123,
    null,
    'a b c d e f g h i',
  ])('rejects unsafe token %j', async (token) => {
    const { adapter, processMessage } = setup();
    expect((await adapter.handleWebhook(challenge(token))).status).toBe(400);
    expect(processMessage).not.toHaveBeenCalled();
  });
  it.each(['1725442341abc', '1'.repeat(100), 1725442341, null])(
    'rejects invalid challenge timestamp %j',
    async (ts) => {
      expect(
        (await setup().adapter.handleWebhook(challenge('Arq0D5A61EgUu4OxUvOp', ts))).status,
      ).toBe(400);
    },
  );
  it('rejects old/future challenge timestamps and wrong app identity', async () => {
    const { adapter } = setup();
    for (const offset of [-301, 301])
      expect(
        (await adapter.handleWebhook(challenge('Arq0D5A61EgUu4OxUvOp', timestamp(offset)))).status,
      ).toBe(400);
    const req = challenge('Arq0D5A61EgUu4OxUvOp');
    req.headers.set('X-Bot-Appid', 'other');
    expect((await adapter.handleWebhook(req)).status).toBe(401);
  });
});

describe('exclusive internal gateway mode', () => {
  it('accepts only via configured authenticator, without native replay claims', async () => {
    const authenticateWebhook = vi.fn(async (req: Request) => {
      expect(await req.clone().text()).toBe(raw);
    });
    const claimWebhookReplay = vi.fn();
    const { adapter, processMessage } = setup({ authenticateWebhook, claimWebhookReplay });
    expect(
      (await adapter.handleWebhook(new Request(url, { body: raw, method: 'POST' }))).status,
    ).toBe(200);
    expect(authenticateWebhook).toHaveBeenCalledOnce();
    expect(claimWebhookReplay).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledOnce();
  });
  it('never falls back to valid native signatures or unsigned challenges', async () => {
    const { adapter, processMessage } = setup({
      authenticateWebhook: async () => new Response('denied', { status: 401 }),
    });
    expect((await adapter.handleWebhook(request())).status).toBe(401);
    expect(
      (
        await adapter.handleWebhook(
          request(
            JSON.stringify({
              d: { event_ts: timestamp(), plain_token: 'Arq0D5A61EgUu4OxUvOp' },
              op: 13,
            }),
          ),
        )
      ).status,
    ).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
  });
  it('fails closed on auth exceptions', async () => {
    const { adapter, processMessage } = setup({
      authenticateWebhook: async () => {
        throw new Error('secret');
      },
    });
    expect((await adapter.handleWebhook(request())).status).toBe(503);
    expect(processMessage).not.toHaveBeenCalled();
  });
});

it('verifies independently signed bytes and refuses an empty secret', () => {
  const ts = timestamp();
  expect(verifyWebhookSignature(ts, Buffer.from(raw), signature(raw, ts), secret)).toBe(true);
  expect(() => signWebhookResponse(ts, 'token', '')).toThrow();
  expect(() => setup({ clientSecret: '' })).toThrow();
});

it('bounds the local cache without evicting live claims, then releases expired entries', async () => {
  vi.useFakeTimers();
  const now = Date.now() + 1_000_000;
  vi.setSystemTime(now);
  const bytes = Buffer.from(raw);
  const ts = timestamp();
  try {
    for (let i = 0; i < 10_000; i++) {
      expect(await claimReplay(`bounded-app-${i}`, ts, bytes)).toBe(true);
    }
    await expect(claimReplay('overflow', ts, bytes)).rejects.toThrow('Replay cache full');
    expect(await claimReplay('bounded-app-0', ts, bytes)).toBe(false);
  } finally {
    vi.setSystemTime(now + 602_000);
    expect(await claimReplay('after-expiry', timestamp(), bytes)).toBe(true);
  }
});
