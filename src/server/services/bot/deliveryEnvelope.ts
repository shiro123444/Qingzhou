import { z } from 'zod';

import type { DeliveryEnvelope } from '@/database/models/botDelivery';

import { callbackHash, callbackScopeKey } from './callbackLedger';

export const BOT_CALLBACK_PATH = '/api/agent/webhooks/bot-callback';
export const MAX_CALLBACK_BYTES = 1024 * 1024;
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
export const durableCallbackSchema = z
  .object({
    applicationId: id,
    content: z.string().optional(),
    errorMessage: z.string().optional(),
    lastAssistantContent: z.string().optional(),
    messengerInstallationKey: id.optional(),
    messengerPlatformUserId: id.optional(),
    operationId: id,
    platformThreadId: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    progressMessageId: id.optional(),
    reason: z.string().max(64).optional(),
    stepIndex: z.number().int().nonnegative().safe().optional(),
    type: z.enum(['step', 'completion']),
    userId: id,
  })
  .passthrough()
  .superRefine((body, ctx) => {
    if (body.type === 'step' && body.stepIndex === undefined)
      ctx.addIssue({ code: 'custom', message: 'Step index is required' });
  });

/** Pure serialization/identity; never accepts a caller-supplied destination URL or queue state. */
export function deliveryEnvelope(input: unknown): DeliveryEnvelope {
  durableCallbackSchema.parse(input);
  // Keep the original property order for legacy Redis fingerprints. SQL stores payload as JSON wire text,
  // not a database-decoded JSON/JSONB object; the event intent hash below is separately canonicalized for queue deduplication.
  const body = input as z.infer<typeof durableCallbackSchema>;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_CALLBACK_BYTES)
    throw new Error('callback_too_large');
  const scopeKey = callbackScopeKey(body);
  const event = body.type === 'completion' ? 'completion' : `step:${body.stepIndex}`;
  // Transport timing/observability fields are not business identity. Freeze the first payload.
  const {
    duration: _duration,
    elapsedMs: _elapsedMs,
    executionTimeMs: _executionTimeMs,
    hookId: _hookId,
    hookType: _hookType,
    ...intent
  } = body;
  const stable = JSON.parse(
    JSON.stringify(intent, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    ),
  );
  const intentHash = callbackHash(stable);
  return {
    eventKey: callbackHash([scopeKey, event]),
    intentHash,
    operationId: body.operationId,
    payload: body,
    priority: body.type === 'completion' ? 100 : 0,
    scopeKey,
    userId: body.userId,
  };
}
