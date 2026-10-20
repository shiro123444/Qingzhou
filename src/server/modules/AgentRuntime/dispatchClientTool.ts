import type { ChatToolPayload } from '@lobechat/types';
import debug from 'debug';

import type { ToolExecutionResultResponse } from '@/server/services/toolExecution/types';

import { getAgentRuntimeRedisClient } from './redis';
import { GLOBAL_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './resolveToolTimeout';
import type { ToolResultPayload } from './ToolResultWaiter';
import { ToolResultWaiter } from './ToolResultWaiter';
import type { IStreamEventManager } from './types';

const log = debug('lobe-server:agent-runtime:dispatch-client-tool');

interface DispatchContext {
  assertStepLease?: () => void;
  operationId: string;
  signal?: AbortSignal;
  streamManager: IStreamEventManager;
  /**
   * Per-call execution budget in milliseconds, normally produced by
   * `resolveToolTimeoutMs`. When omitted, falls back to the global default
   * (`GLOBAL_DEFAULT_TIMEOUT_MS`). Always clamped to
   * `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]` regardless of source — the client is
   * a suggester, this dispatcher is the arbiter.
   */
  timeoutMs?: number;
}

const clampTimeout = (value: number): number =>
  Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

const buildTimeoutResult = (executionTime: number): ToolExecutionResultResponse => ({
  content: '',
  error: { message: 'Tool execution timed out', type: 'timeout' },
  executionTime,
  success: false,
});

const buildErrorResult = (
  executionTime: number,
  error: unknown,
  type = 'dispatch_failed',
): ToolExecutionResultResponse => ({
  content: '',
  error: {
    message: error instanceof Error ? error.message : String(error),
    type,
  },
  executionTime,
  success: false,
});

/**
 * Dispatch a tool execution to the client via Agent Gateway WebSocket and
 * block-await the result on Redis. Dispatch errors become failed tool results,
 * but abort/lease loss must propagate so a stale worker cannot continue.
 *
 * The caller is expected to gate on `typeof streamManager.sendToolExecute ===
 * 'function'` and `chatToolPayload.executor === 'client'` before invoking.
 */
export async function dispatchClientTool(
  chatToolPayload: ChatToolPayload,
  ctx: DispatchContext,
): Promise<ToolExecutionResultResponse> {
  const { operationId, streamManager } = ctx;
  const startedAt = Date.now();
  const assertActive = () => {
    ctx.signal?.throwIfAborted();
    ctx.assertStepLease?.();
  };
  assertActive();

  if (typeof streamManager.sendToolExecute !== 'function') {
    return buildErrorResult(
      0,
      'Gateway notifier does not support tool_execute',
      'gateway_unsupported',
    );
  }

  const redis = getAgentRuntimeRedisClient();
  if (!redis) {
    return buildErrorResult(
      0,
      'Redis is not available for tool result waiting',
      'redis_unavailable',
    );
  }

  // BLPOP holds the underlying socket, so we need a dedicated connection per
  // dispatch. Cleanup in `finally` so we never leak on the error path.
  const blockingClient = redis.duplicate();
  const waiter = new ToolResultWaiter(blockingClient, redis);

  const timeoutMs = clampTimeout(ctx.timeoutMs ?? GLOBAL_DEFAULT_TIMEOUT_MS);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(ctx.signal?.reason);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
  });
  // Observe cancellation even if the transport has not yet returned a promise.
  void aborted.catch(() => {});

  try {
    assertActive();
    log(
      '[%s] dispatching client tool %s/%s (toolCallId=%s, timeout=%dms)',
      operationId,
      chatToolPayload.identifier,
      chatToolPayload.apiName,
      chatToolPayload.id,
      timeoutMs,
    );

    await Promise.race([
      streamManager.sendToolExecute(operationId, {
        apiName: chatToolPayload.apiName,
        arguments: chatToolPayload.arguments,
        executionTimeoutMs: timeoutMs,
        identifier: chatToolPayload.identifier,
        toolCallId: chatToolPayload.id,
      }),
      aborted,
    ]);
    assertActive();

    const result = await Promise.race([
      waiter.waitForResult(chatToolPayload.id, timeoutMs),
      aborted,
    ]);
    assertActive();
    const executionTime = Date.now() - startedAt;

    if (!result) {
      log(
        '[%s] client tool %s timed out after %dms',
        operationId,
        chatToolPayload.id,
        executionTime,
      );
      return buildTimeoutResult(executionTime);
    }

    return projectToExecutionResult(result, executionTime);
  } catch (error) {
    assertActive();
    const executionTime = Date.now() - startedAt;
    log('[%s] client tool dispatch failed: %O', operationId, error);
    return buildErrorResult(executionTime, error);
  } finally {
    if (onAbort) ctx.signal?.removeEventListener('abort', onAbort);
    blockingClient.disconnect();
  }
}

function projectToExecutionResult(
  payload: ToolResultPayload,
  executionTime: number,
): ToolExecutionResultResponse {
  return {
    content: payload.content ?? '',
    error: payload.error,
    executionTime,
    state: payload.state,
    success: payload.success,
  };
}
