import {
  BOT_CALLBACK_PATH,
  normalizeBotPausePayload,
} from '@/server/services/bot/deliveryEnvelope';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

import type { AgentHookEvent, AgentHookType, AnyHookEvent, SerializedHook } from './types';

export function buildWebhookPayload(
  event: AnyHookEvent,
  eventFields?: (keyof AgentHookEvent)[],
): Record<string, unknown> {
  if (Array.isArray(eventFields)) {
    const payload: Record<string, unknown> = {};
    for (const field of eventFields) {
      if (field !== 'finalState' && typeof field === 'string' && Object.hasOwn(event, field))
        payload[field] = event[field as keyof AnyHookEvent];
    }
    return payload;
  }
  const { finalState: _state, ...payload } = event as AnyHookEvent & { finalState?: unknown };
  return payload;
}

export function collectBotCallbackIntents(
  operationId: string,
  type: AgentHookType,
  event: AnyHookEvent,
  hooks?: SerializedHook[],
): Record<string, unknown>[] {
  if (!isQueueAgentRuntimeEnabled()) return [];
  return (Array.isArray(hooks) ? hooks : [])
    .filter((hook) => hook?.type === type && hook.webhook?.url === BOT_CALLBACK_PATH)
    .flatMap((hook) => {
      const payload: Record<string, unknown> = normalizeBotPausePayload({
        ...buildWebhookPayload(event, hook.webhook.eventFields),
        ...hook.webhook.body,
        hookId: hook.id,
        hookType: type,
        operationId,
        userId: event.userId,
      });
      if (payload.type === 'completion' && payload.reason === 'waiting_for_human') return [];
      return [payload];
    });
}
