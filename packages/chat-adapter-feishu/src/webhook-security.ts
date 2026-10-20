import { createHash, timingSafeEqual } from 'node:crypto';

import { decryptLarkEvent } from './crypto';
import type { LarkAdapterConfig, LarkWebhookPayload } from './types';

const WINDOW_SECONDS = 300;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REPLAY_ENTRIES = 10_000;

// Standalone-package fallback only: bounded, process-local and lost on restart.
// Multi-worker/server deployments MUST inject a durable shared replay claim.
const replayCache = new Map<string, number>();

async function localClaim(key: string, ttlSeconds: number): Promise<boolean> {
  const now = Date.now();
  for (const [entry, expiry] of replayCache) {
    if (expiry <= now) replayCache.delete(entry);
  }
  if (replayCache.has(key)) return false;
  // Do not evict live entries: doing so would reopen the replay window.
  if (replayCache.size >= MAX_REPLAY_ENTRIES) throw new Error('Replay cache full');
  replayCache.set(key, now + ttlSeconds * 1000);
  return true;
}

function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Buffer | Response> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Webhook body read timeout')), 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return new Response('Request body too large', { status: 413 });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch {
    void reader.cancel().catch(() => {});
    return new Response('Invalid request body', { status: 400 });
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

/** Authentication is selected by trusted configuration, never by request headers. */
export async function authenticateLarkWebhook(
  request: Request,
  config: LarkAdapterConfig,
): Promise<LarkWebhookPayload | Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const internal = !!config.authenticateWebhook;
  if (config.authenticateWebhook) {
    try {
      const rejection = await config.authenticateWebhook(request);
      if (rejection) return rejection;
    } catch {
      return new Response('Webhook authentication unavailable', { status: 503 });
    }
  }

  const raw = await readBody(request);
  if (raw instanceof Response) return raw;
  let body: LarkWebhookPayload;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!isObject(parsed)) return new Response('Invalid payload', { status: 400 });
    body = parsed;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // The trusted internal gateway authenticates its own envelope and replay nonce.
  // Never reinterpret its payload as native encrypted events or token challenges.
  if (internal) {
    if (body.encrypt || body.type === 'url_verification') {
      return new Response('Invalid gateway payload', { status: 400 });
    }
    return body;
  }

  // Official unencrypted URL registration uses only type/token/challenge, no app_id.
  // This narrow exception cannot dispatch an event and never accepts absent secrets.
  if (
    !request.headers.has('X-Lark-Signature') &&
    !request.headers.has('X-Lark-Request-Timestamp') &&
    !request.headers.has('X-Lark-Request-Nonce') &&
    !body.encrypt &&
    body.type === 'url_verification' &&
    typeof body.challenge === 'string' &&
    body.challenge.length > 0 &&
    config.verificationToken &&
    equalSecret(body.token, config.verificationToken)
  ) {
    return Response.json({ challenge: body.challenge });
  }

  if (!config.encryptKey?.trim()) {
    return new Response('Encrypt Key is required for external webhook events', { status: 503 });
  }
  const timestamp = request.headers.get('X-Lark-Request-Timestamp') || '';
  const nonce = request.headers.get('X-Lark-Request-Nonce') || '';
  const signature = request.headers.get('X-Lark-Signature') || '';
  if (
    !/^\d{10}$/.test(timestamp) ||
    !/^[\x21-\x7E]{1,256}$/.test(nonce) ||
    !/^[\da-f]{64}$/i.test(signature) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > WINDOW_SECONDS
  ) {
    return new Response('Invalid webhook signature metadata', { status: 401 });
  }
  const expected = createHash('sha256')
    .update(timestamp + nonce + config.encryptKey)
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    return new Response('Invalid webhook signature', { status: 401 });
  }

  // Verify the signature over the exact ciphertext envelope BEFORE decryption.
  if (body.encrypt !== undefined) {
    try {
      if (typeof body.encrypt !== 'string') throw new Error('Invalid ciphertext');
      const decrypted: unknown = JSON.parse(decryptLarkEvent(body.encrypt, config.encryptKey));
      if (!isObject(decrypted)) throw new Error('Invalid payload');
      body = decrypted;
    } catch {
      return new Response('Invalid encrypted event', { status: 401 });
    }
  }
  if (
    config.verificationToken &&
    !equalSecret(
      body.type === 'url_verification' ? body.token : body.header?.token,
      config.verificationToken,
    )
  ) {
    return new Response('Invalid verification token', { status: 401 });
  }
  if (body.type === 'url_verification') {
    if (typeof body.challenge !== 'string' || !body.challenge) {
      return new Response('Invalid challenge', { status: 400 });
    }
    // Handshakes do not dispatch; allow retries of the identical challenge.
    return Response.json({ challenge: body.challenge });
  }
  if (!isObject(body.header) || body.header.app_id !== config.appId) {
    return new Response('Invalid webhook application', { status: 401 });
  }

  // The SQL inbox owns replay deduplication when durable receipt is installed.
  // Claiming a nonce first would prevent an identical authenticated retry after a 503.
  if (config.persistVerifiedWebhook) return body;

  // Hash the nonce and timestamp with unambiguous framing; include trusted tenant scope.
  const replayId = createHash('sha256')
    .update(JSON.stringify([timestamp, nonce]))
    .digest('hex');
  const key = `lark-webhook:${config.platform || 'lark'}:${config.appId}:${replayId}`;
  try {
    const claim = config.claimWebhookReplay || localClaim;
    if (!(await claim(key, WINDOW_SECONDS * 2 + 1))) {
      return new Response('Webhook replay rejected', { status: 409 });
    }
  } catch {
    return new Response('Webhook replay protection unavailable', { status: 503 });
  }
  return body;
}
