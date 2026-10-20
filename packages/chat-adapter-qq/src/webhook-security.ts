import { createHash } from 'node:crypto';

const MAX_BODY_BYTES = 1024 * 1024;
const REPLAY_TTL_SECONDS = 601;
const MAX_REPLAY_ENTRIES = 10_000;
// Shared by adapters in this process only; restarts/other workers require a shared atomic store.
// Never evict live claims to admit new ones: saturation fails closed.
const replayCache = new Map<string, number>();

export function isFreshTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{9}$/.test(value) &&
    Math.abs(Date.now() / 1000 - Number(value)) <= 300
  );
}

export async function readWebhookBody(request: Request): Promise<Buffer | Response> {
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
        return new Response('Payload too large', { status: 413 });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } catch {
    void reader.cancel().catch(() => {});
    return new Response('Invalid body', { status: 400 });
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function claimReplay(
  appId: string,
  timestamp: string,
  body: Buffer,
  claim?: (key: string, ttlSeconds: number) => Promise<boolean>,
): Promise<boolean> {
  // Native QQ signatures do not bind URL paths: aliases must share replay claims.
  const digest = createHash('sha256')
    .update(JSON.stringify(['qq', appId, timestamp]))
    .update(body)
    .digest('hex');
  const key = `qq:webhook:${digest}`;
  if (claim) return claim(key, REPLAY_TTL_SECONDS);
  const now = Date.now();
  for (const [entry, expires] of replayCache) {
    if (expires <= now) replayCache.delete(entry);
  }
  if (replayCache.has(key)) return false;
  if (replayCache.size >= MAX_REPLAY_ENTRIES) throw new Error('Replay cache full');
  replayCache.set(key, now + REPLAY_TTL_SECONDS * 1000);
  return true;
}
