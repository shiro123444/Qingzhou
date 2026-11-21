import type {
  AgentHookType,
  AnyHookEvent,
  SerializedHook,
} from '@/server/services/agentRuntime/hooks/types';

import type { WakeInput } from './wakeStore';

export const NATIVE_THREAD_CALLBACK = 'qingzhou:thread-lifecycle';
export const TASK_COMPLETION_CALLBACK = '/api/workflows/task/on-topic-complete';
/** Trusted built-in callbacks become local durable commands, never self-HTTP. */
export function collectNativeCallbackIntents(
  operationId: string,
  type: AgentHookType,
  event: AnyHookEvent,
  hooks?: SerializedHook[],
): WakeInput[] {
  const state = (event as any).finalState;
  const metadata = state?.metadata ?? {};
  if (!metadata.userId) return [];
  return (hooks ?? []).flatMap<WakeInput>((hook) => {
    if (hook.type !== type) return [];
    const body = hook.webhook?.body ?? {};
    if (hook.webhook?.url === TASK_COMPLETION_CALLBACK && type === 'onComplete') {
      if (state.status === 'waiting_for_human') return [];
      if (!metadata.taskId || body.taskId !== metadata.taskId)
        throw new Error('NATIVE_TASK_CALLBACK_SCOPE_MISMATCH');
      return [
        {
          kind: 'task-complete',
          userId: metadata.userId,
          key: `${operationId}:${hook.id}`,
          scopeKey: `task:${metadata.taskId}`,
          payload: {
            operationId,
            taskId: metadata.taskId,
            version: metadata.nativeTaskVersion,
            taskIdentifier: body.taskIdentifier,
            topicId: metadata.topicId,
            reason: (event as any).reason ?? state.status,
            lastAssistantContent: (event as any).lastAssistantContent,
            errorMessage: (event as any).errorMessage,
          },
        },
      ];
    }
    if (
      hook.webhook?.url === NATIVE_THREAD_CALLBACK &&
      ['afterStep', 'onComplete'].includes(type)
    ) {
      if (
        !metadata.threadId ||
        body.threadId !== metadata.threadId ||
        body.sourceMessageId !== metadata.sourceMessageId
      )
        throw new Error('NATIVE_THREAD_CALLBACK_SCOPE_MISMATCH');
      return [
        {
          kind: type === 'afterStep' ? 'thread-step' : 'thread-complete',
          userId: metadata.userId,
          key: `${operationId}:${hook.id}:${state.stepCount}:${state.status}`,
          scopeKey: `thread:${metadata.threadId}`,
          payload: {
            operationId,
            threadId: metadata.threadId,
            sourceMessageId: metadata.sourceMessageId,
            startedAt: body.startedAt,
          },
        },
      ];
    }
    return [];
  });
}
