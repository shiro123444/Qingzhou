import debug from 'debug';

import {
  BOT_CALLBACK_PATH,
  normalizeBotPausePayload,
} from '@/server/services/bot/deliveryEnvelope';
import { enqueueBotOutbox } from '@/server/services/bot/deliveryStore';
import { isQueueAgentRuntimeEnabled } from '@/server/services/queue/impls';

import { buildWebhookPayload } from './payload';
import type {
  AgentHook,
  AgentHookEvent,
  AgentHookType,
  AnyHookEvent,
  SerializedHook,
  ToolCallHookEvent,
} from './types';
import type { WebhookFailureCode } from './webhookDelivery';
import { deliverWebhook, WebhookDeliveryError } from './webhookDelivery';

const log = debug('lobe-server:hook-dispatcher');

function frozenBotPayload(event: AnyHookEvent, payload: Record<string, unknown>) {
  payload = normalizeBotPausePayload(payload);
  const prepared = (event as AgentHookEvent).finalState?.metadata?._pendingBotCallbacks;
  return (
    (Array.isArray(prepared)
      ? prepared.find(
          (entry) =>
            entry?.operationId === payload.operationId &&
            entry?.hookId === payload.hookId &&
            entry?.hookType === payload.hookType &&
            entry?.userId === event.userId &&
            entry?.applicationId === payload.applicationId &&
            entry?.platformThreadId === payload.platformThreadId &&
            entry?.messengerInstallationKey === payload.messengerInstallationKey &&
            entry?.type === payload.type,
        )
      : undefined) ?? { ...payload, userId: event.userId }
  );
}

export interface HookDispatchFailure {
  code: WebhookFailureCode | 'LOCAL_HANDLER_FAILED';
  delivery: 'fetch' | 'qstash' | 'local' | 'sql-outbox';
  hookId: string;
  hookType: AgentHookType;
  operationId: string;
  status?: number;
}

export interface HookDispatchResult {
  failures: HookDispatchFailure[];
  /** Success means handler completion or durable/transport acceptance, not final platform delivery. */
  success: boolean;
}

/**
 * HookDispatcher — central hub for registering and dispatching agent lifecycle hooks
 *
 * Local mode: hooks are stored in memory, handler functions called directly
 * Production mode: webhook configs persisted in AgentState.metadata._hooks,
 *   delivered via HTTP POST or QStash
 */
export class HookDispatcher {
  /**
   * In-memory hook store (local mode)
   * Maps operationId → AgentHook[]
   */
  private hooks: Map<string, AgentHook[]> = new Map();

  /**
   * Dispatch hooks for a given event type
   *
   * In local mode: calls handler functions from memory
   * In production mode: delivers webhooks from serialized config.
   * Delivery failures are returned separately, never thrown into the successful tool execution path.
   * Lease assertion failures propagate immediately to fence subsequent hook side effects.
   * Built-in bot callbacks enter a durable outbox; custom webhook failures are not automatically replayed.
   */
  async dispatch(
    operationId: string,
    type: AgentHookType,
    event: AnyHookEvent,
    serializedHooks?: SerializedHook[],
    assertStepLease?: () => void,
  ): Promise<HookDispatchResult> {
    assertStepLease?.();
    const failures: HookDispatchFailure[] = [];
    const isQueueMode = isQueueAgentRuntimeEnabled();

    if (!isQueueMode) {
      // Local mode: call handler functions directly
      const hooks = this.hooks.get(operationId)?.filter((h) => h.type === type) || [];

      for (const hook of hooks) {
        assertStepLease?.();
        try {
          log('[%s][%s] Dispatching local hook: %s', operationId, type, hook.id);
          if (hook.webhook?.url === BOT_CALLBACK_PATH) {
            const payload = {
              ...buildWebhookPayload(event, hook.webhook.eventFields),
              ...hook.webhook.body,
              operationId,
              hookId: hook.id,
              hookType: type,
              userId: event.userId,
            };
            try {
              await enqueueBotOutbox(frozenBotPayload(event, payload), assertStepLease);
            } catch {
              assertStepLease?.();
              const failure: HookDispatchFailure = {
                code: 'OUTBOX_PERSIST_FAILED',
                delivery: 'sql-outbox',
                hookId: hook.id,
                hookType: type,
                operationId,
              };
              failures.push(failure);
              console.error('[HookDispatcher] Durable local callback deferred', failure);
              // The runtime's frozen pending intent is retried by the delivery worker.
              // Finish local lifecycle cleanup without sending a second platform reply.
            }
          }
          await hook.handler(event as AgentHookEvent);
        } catch (error) {
          assertStepLease?.();
          log('[%s][%s] Hook error (non-fatal): %s %O', operationId, type, hook.id, error);
          failures.push({
            code: 'LOCAL_HANDLER_FAILED',
            delivery: 'local',
            hookId: hook.id,
            hookType: type,
            operationId,
          });
          // Hook failures must not turn a successful tool step into a retry.
        }
        // Keep assertions outside the hook catch: ownership loss is not a delivery failure.
        assertStepLease?.();
      }
    } else {
      // Production mode: deliver via webhooks
      const webhookHooks =
        serializedHooks?.filter((h) => h.type === type && h.webhook) ||
        this.getSerializedHooks(operationId)?.filter((h) => h.type === type) ||
        [];

      for (const hook of webhookHooks) {
        assertStepLease?.();
        try {
          log('[%s][%s] Delivering webhook hook: %s', operationId, type, hook.id);
          const webhookPayload = buildWebhookPayload(event, hook.webhook.eventFields);
          const payload: Record<string, unknown> = {
            ...webhookPayload,
            ...hook.webhook.body,
            operationId,
            hookId: hook.id,
            hookType: type,
          };
          if (hook.webhook.url === BOT_CALLBACK_PATH) {
            // Internal callbacks enter SQL, not a self-HTTP request or QStash fallback.
            await enqueueBotOutbox(frozenBotPayload(event, payload), assertStepLease).catch(() => {
              throw new WebhookDeliveryError('OUTBOX_PERSIST_FAILED');
            });
          } else {
            await deliverWebhook(hook.webhook, payload, assertStepLease);
          }
        } catch (error) {
          assertStepLease?.();
          const failure: HookDispatchFailure = {
            code: error instanceof WebhookDeliveryError ? error.code : 'WEBHOOK_FAILED',
            delivery:
              hook.webhook.url === BOT_CALLBACK_PATH
                ? 'sql-outbox'
                : (hook.webhook.delivery ?? 'fetch'),
            hookId: hook.id,
            hookType: type,
            operationId,
            ...(error instanceof WebhookDeliveryError && error.status !== undefined
              ? { status: error.status }
              : {}),
          };
          failures.push(failure);
          // Always observable even when callers ignore the result or debug logging is disabled.
          // Do not include URLs, response bodies, credentials, or raw provider errors.
          console.error('[HookDispatcher] Webhook delivery failed', failure);
        }
        assertStepLease?.();
      }
    }

    return { failures, success: failures.length === 0 };
  }

  /**
   * Dispatch beforeToolCall hooks with mock support.
   * Returns mock result if any handler called event.mock(), otherwise null.
   */
  async dispatchBeforeToolCall(
    operationId: string,
    event: Omit<ToolCallHookEvent, 'mock' | 'operationId'>,
    assertStepLease?: () => void,
  ): Promise<{ content: string; isMocked: true } | null> {
    assertStepLease?.();
    const hooks = this.hooks.get(operationId)?.filter((h) => h.type === 'beforeToolCall') || [];
    if (hooks.length === 0) return null;

    let isMocked = false;
    let mockedContent = '';

    const toolCallEvent: ToolCallHookEvent = {
      ...event,
      mock: (result) => {
        // Only accept non-empty string content
        if (typeof result?.content === 'string' && result.content.length > 0) {
          isMocked = true;
          mockedContent = result.content;
        } else {
          log(
            '[%s][beforeToolCall] mock() called with invalid content (must be non-empty string), ignoring',
            operationId,
          );
        }
      },
      operationId,
    };

    for (const hook of hooks) {
      assertStepLease?.();
      try {
        log('[%s][beforeToolCall] Dispatching: %s', operationId, hook.id);
        await hook.handler(toolCallEvent as any);
      } catch (error) {
        assertStepLease?.();
        log('[%s][beforeToolCall] Hook error (non-fatal): %s %O', operationId, hook.id, error);
      }
      assertStepLease?.();
    }

    return isMocked ? { content: mockedContent, isMocked: true } : null;
  }

  /**
   * Get serialized hooks for an operation (for production mode persistence)
   */
  getSerializedHooks(operationId: string): SerializedHook[] | undefined {
    const hooks = this.hooks.get(operationId);
    if (!hooks) return undefined;

    return hooks
      .filter((h) => h.webhook)
      .map((h) => ({
        id: h.id,
        type: h.type,
        webhook: h.webhook!,
      }));
  }

  /**
   * Check if any hooks are registered for an operation
   */
  hasHooks(operationId: string): boolean {
    return (this.hooks.get(operationId)?.length ?? 0) > 0;
  }

  /**
   * Register hooks for an operation
   *
   * In local mode: stores hooks in memory (including handler functions)
   * In production mode: caller should persist getSerializedHooks() to state.metadata._hooks
   */
  register(operationId: string, hooks: AgentHook[]): void {
    if (hooks.length === 0) return;

    const existing = this.hooks.get(operationId) || [];
    this.hooks.set(operationId, [...existing, ...hooks]);

    log(
      '[%s] Registered %d hooks: %s',
      operationId,
      hooks.length,
      hooks.map((h) => `${h.type}:${h.id}`).join(', '),
    );
  }

  /**
   * Unregister all hooks for an operation (cleanup)
   */
  unregister(operationId: string): void {
    this.hooks.delete(operationId);
    log('[%s] Unregistered all hooks', operationId);
  }
}

/**
 * Singleton instance — shared across the application
 */
export const hookDispatcher = new HookDispatcher();
