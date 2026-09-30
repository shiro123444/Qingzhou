import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_GATEWAY_BODY_BYTES = 1024 * 1024;
export const GATEWAY_CLOCK_WINDOW_SECONDS = 300;
const REPLAY_TTL_SECONDS = GATEWAY_CLOCK_WINDOW_SECONDS * 2 + 1;
const PURPOSE = 'qingzhou.bot.gateway.v1';

export const GATEWAY_AUTH_HEADERS = {
  nonce: 'x-qingzhou-gateway-nonce',
  signature: 'x-qingzhou-gateway-signature',
  timestamp: 'x-qingzhou-gateway-timestamp',
} as const;

export type ClaimWebhookReplay = (key: string, ttlSeconds: number) => Promise<boolean>;

/** Shared atomic replay protection. Never silently downgrade to a process-local cache. */
export const claimWebhookReplay: ClaimWebhookReplay = async (key, ttlSeconds) => {
  if (!key || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
    throw new Error('Invalid webhook replay claim');
  }
  const { getAgentRuntimeRedisClient } = await import('@/server/modules/AgentRuntime/redis');
  const redis = getAgentRuntimeRedisClient();
  if (!redis) throw new Error('Webhook replay protection is unavailable');
  const digest = createHash('sha256').update(key).digest('hex');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      redis.set(`bot:webhook:replay:v1:${digest}`, '1', 'EX', ttlSeconds, 'NX'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Webhook replay store timed out')), 2000);
      }),
    ]);
    return result === 'OK';
  } finally {
    clearTimeout(timer);
  }
};

interface GatewayScope {
  readonly applicationId: string;
  readonly platform: string;
  readonly secret: string;
}

const validScope = (scope: GatewayScope): boolean =>
  [scope.applicationId, scope.platform, scope.secret].every(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );

const signatureFor = (
  scope: GatewayScope,
  url: string,
  body: Uint8Array,
  timestamp: string,
  nonce: string,
): string => {
  const target = new URL(url);
  const key = createHmac('sha256', scope.secret).update(PURPOSE).digest();
  const canonical = JSON.stringify([
    PURPOSE,
    scope.platform,
    scope.applicationId,
    'POST',
    target.pathname + target.search,
    timestamp,
    nonce,
    createHash('sha256').update(body).digest('hex'),
  ]);
  return createHmac('sha256', key).update(canonical).digest('hex');
};

/** Sign the exact serialized bytes. Redirects must not carry a trusted forwarding envelope elsewhere. */
export const signGatewayRequest = (
  options: GatewayScope & { readonly body: string; readonly url: string },
): RequestInit => {
  if (!validScope(options)) throw new Error('Gateway credentials are not configured');
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Gateway target URL is invalid');
  }
  const body = Buffer.from(options.body, 'utf8');
  if (body.byteLength > MAX_GATEWAY_BODY_BYTES) throw new Error('Gateway payload is too large');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(24).toString('hex');
  return {
    body: options.body,
    headers: {
      'Content-Type': 'application/json',
      [GATEWAY_AUTH_HEADERS.nonce]: nonce,
      [GATEWAY_AUTH_HEADERS.signature]: signatureFor(options, options.url, body, timestamp, nonce),
      [GATEWAY_AUTH_HEADERS.timestamp]: timestamp,
    },
    method: 'POST',
    redirect: 'error',
  };
};

class PayloadLimitError extends Error {}

/** Read a clone so the adapter can consume the original body after authentication. */
const readBoundedBody = async (request: Request): Promise<Uint8Array> => {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_GATEWAY_BODY_BYTES) {
    throw new PayloadLimitError();
  }
  const reader = request.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Webhook body read timeout')), 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GATEWAY_BODY_BYTES) throw new PayloadLimitError();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    // Cancelling one side of a tee can wait for the other side: do not await it.
    void reader.cancel().catch(() => {});
    void request.body?.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
};

/**
 * Installed by server-owned polling/WS clients only. No wire header can select
 * this authentication mode. Scope and secret come from the selected installation.
 */
export const createGatewayAuthenticator = (
  options: GatewayScope & {
    readonly claimReplay?: ClaimWebhookReplay;
    readonly now?: () => number;
  },
): ((request: Request) => Promise<Response | void>) => {
  const claim = options.claimReplay ?? claimWebhookReplay;
  return async (request) => {
    if (!validScope(options)) return new Response('Gateway is not configured', { status: 503 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const timestamp = request.headers.get(GATEWAY_AUTH_HEADERS.timestamp) ?? '';
    const nonce = request.headers.get(GATEWAY_AUTH_HEADERS.nonce) ?? '';
    const signature = request.headers.get(GATEWAY_AUTH_HEADERS.signature) ?? '';
    const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
    if (
      !/^\d{10}$/u.test(timestamp) ||
      !/^[\da-f]{48}$/u.test(nonce) ||
      !/^[\da-f]{64}$/u.test(signature) ||
      Math.abs(now - Number(timestamp)) > GATEWAY_CLOCK_WINDOW_SECONDS
    ) {
      return new Response('Invalid gateway authentication', { status: 401 });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(request);
    } catch (error) {
      return new Response(
        error instanceof PayloadLimitError ? 'Payload too large' : 'Invalid body',
        {
          status: error instanceof PayloadLimitError ? 413 : 400,
        },
      );
    }
    const expected = signatureFor(options, request.url, bytes, timestamp, nonce);
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      return new Response('Invalid gateway authentication', { status: 401 });
    }
    try {
      // Partition by scope, not by caller-controlled identity or a shared nonce alone.
      const key = JSON.stringify([PURPOSE, options.platform, options.applicationId, nonce]);
      if (!(await claim(key, REPLAY_TTL_SECONDS))) {
        return new Response('Gateway request already received', { status: 409 });
      }
    } catch {
      return new Response('Webhook replay protection is unavailable', { status: 503 });
    }
  };
};
