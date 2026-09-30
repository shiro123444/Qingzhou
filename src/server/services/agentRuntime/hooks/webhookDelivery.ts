import { randomUUID } from 'node:crypto';

import urlJoin from 'url-join';

import type { AgentHookWebhook } from './types';

export const WEBHOOK_FETCH_TIMEOUT_MS = 10_000;

export type WebhookFailureCode =
  | 'OUTBOX_PERSIST_FAILED'
  | 'QSTASH_TOKEN_MISSING'
  | 'QSTASH_PUBLISH_FAILED'
  | 'FETCH_TIMEOUT'
  | 'FETCH_FAILED'
  | 'HTTP_ERROR'
  | 'WEBHOOK_FAILED';

/** Deliberately excludes raw errors, response bodies and potentially secret destination URLs. */
export class WebhookDeliveryError extends Error {
  constructor(
    public readonly code: WebhookFailureCode,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'WebhookDeliveryError';
  }
}

export async function deliverWebhook(
  webhook: AgentHookWebhook,
  payload: Record<string, unknown>,
  assertStepLease?: () => void,
): Promise<void> {
  assertStepLease?.();
  const { url, delivery = 'fetch' } = webhook;
  const resolvedUrl = url.startsWith('http')
    ? url
    : urlJoin(process.env.INTERNAL_APP_URL || process.env.APP_URL || '', url);

  if (delivery === 'qstash') {
    const token = process.env.QSTASH_TOKEN;
    if (!token) throw new WebhookDeliveryError('QSTASH_TOKEN_MISSING');

    const { Client } = await import('@upstash/qstash').catch(() => {
      assertStepLease?.();
      throw new WebhookDeliveryError('QSTASH_PUBLISH_FAILED');
    });
    // Import can yield long enough for ownership to expire. Fence the first network publication.
    assertStepLease?.();
    try {
      // SDK retries publication network failures twice (three attempts total), not HTTP errors.
      // Do not add an outer retry loop: the same request/deduplication ID is reused by the SDK.
      // Once publication starts, its internal retries are one in-flight delivery; they are not
      // individually lease-aware. The dispatcher fences every subsequent hook delivery.
      const client = new Client({ retry: { backoff: (n) => 100 * 2 ** n, retries: 2 }, token });
      await client.publishJSON({
        body: payload,
        // Deduplication is scoped to this publication's SDK retries, NOT later dispatches.
        // Lifecycle events lack a universal occurrence ID: hashing identical payloads could
        // suppress legitimate repeated tool events. No durable replay is promised here.
        deduplicationId: randomUUID(),
        headers: {
          ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET && {
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          }),
        },
        url: resolvedUrl,
      });
    } catch {
      assertStepLease?.();
      // Authenticated QStash delivery must never degrade into an unsigned direct request.
      throw new WebhookDeliveryError('QSTASH_PUBLISH_FAILED');
    }
    assertStepLease?.();
    return;
  }

  // No await occurs between this assertion and the direct fetch invocation.
  assertStepLease?.();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(resolvedUrl, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
    });
    // No response body is read or logged. Release it without waiting for an untrusted stream.
    void res.body?.cancel().catch(() => {});
    if (!res.ok) throw new WebhookDeliveryError('HTTP_ERROR', res.status);
  } catch (error) {
    assertStepLease?.();
    if (error instanceof WebhookDeliveryError) throw error;
    // A timeout/network failure may mean the recipient already accepted the request.
    // Never blindly retry direct fetch delivery.
    throw new WebhookDeliveryError(controller.signal.aborted ? 'FETCH_TIMEOUT' : 'FETCH_FAILED');
  } finally {
    clearTimeout(timeout);
  }
  assertStepLease?.();
}
