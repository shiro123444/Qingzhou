import { setTimeout } from 'node:timers/promises';

import { type MultimodalChatPort, MultimodalChatProviderError } from './multimodal-chat-provider';

const isRecoverable = (error: unknown): boolean =>
  error instanceof MultimodalChatProviderError &&
  (error.code === 'CHAT_UNAVAILABLE' || error.code === 'CHAT_PAYLOAD_INVALID');

const hasAssistantContent = (result: Awaited<ReturnType<MultimodalChatPort['chat']>>): boolean =>
  result.choices.some((choice) => choice.message.content.trim().length > 0);

const hasAssistantReasoning = (result: Awaited<ReturnType<MultimodalChatPort['chat']>>): boolean =>
  result.choices.some((choice) => (choice.message.reasoning_content?.trim().length ?? 0) > 0);

const isStructuredContinuation = (idempotencyKey?: string): boolean =>
  /:(?:harvest|repair)$/u.test(idempotencyKey?.trim() ?? '');

/** Retry the same inference, never an entire tool workflow. Both channels may fail transiently. */
export const createFallbackMultimodalChatPort = (
  primary: MultimodalChatPort,
  fallback?: MultimodalChatPort,
  options: { retryDelayMs?: number; primaryCooldownMs?: number } = {},
): MultimodalChatPort => {
  let fallbackRejected = false;
  let primaryFailures = 0;
  let primaryUnavailableUntil = 0;
  return {
    manifest: primary.manifest,
    providerId: primary.providerId,
    chat: async (request, context) => {
      const first =
        fallback && !fallbackRejected && Date.now() < primaryUnavailableUntil ? fallback : primary;
      const attempts = [first, fallbackRejected ? primary : (fallback ?? primary), primary];
      for (const [index, provider] of attempts.entries()) {
        if (context.signal?.aborted)
          throw new MultimodalChatProviderError('CHAT_CANCELLED', '模型请求已取消');
        try {
          const result = await provider.chat(request, context);
          if (provider === primary) {
            primaryFailures = 0;
            primaryUnavailableUntil = 0;
          }
          if (hasAssistantContent(result)) return result;
          if (hasAssistantReasoning(result) && !isStructuredContinuation(context.idempotencyKey))
            return result;
          throw new MultimodalChatProviderError('CHAT_PAYLOAD_INVALID', '模型未返回完整回复');
        } catch (error) {
          if (
            provider === primary &&
            fallback &&
            options.primaryCooldownMs &&
            isRecoverable(error)
          ) {
            primaryFailures += 1;
            if (primaryFailures >= 3)
              primaryUnavailableUntil = Date.now() + options.primaryCooldownMs;
          }
          const rejectedFallback =
            provider !== primary &&
            error instanceof MultimodalChatProviderError &&
            error.code === 'CHAT_PROVIDER_REJECTED';
          if (rejectedFallback) fallbackRejected = true;
          if (
            context.signal?.aborted ||
            (!isRecoverable(error) && !rejectedFallback) ||
            index === attempts.length - 1
          )
            throw error;
          context.onRetry?.({ attempt: index + 2, maxAttempts: attempts.length });
          await setTimeout((options.retryDelayMs ?? 500) * (index + 1), undefined, {
            signal: context.signal,
          });
        }
      }
      throw new MultimodalChatProviderError('CHAT_UNAVAILABLE', '模型连接暂不可用');
    },
  };
};

/** Single-provider production policy: retry only transient failures on the configured channel. */
export const createResilientMultimodalChatPort = (
  primary: MultimodalChatPort,
  options: { retryDelayMs?: number } = {},
): MultimodalChatPort => createFallbackMultimodalChatPort(primary, undefined, options);
