import type { MultimodalChatProviderErrorCode } from './multimodal-chat-provider-glm';
import { MultimodalChatProviderError } from './multimodal-chat-provider-glm';

/** Failures that belong to the transport or the provider, never to the content being reviewed. */
const PROVIDER_FAILURE_CODES = new Set<MultimodalChatProviderErrorCode | string>([
  'CHAT_CANCELLED',
  'CHAT_PAYLOAD_INVALID',
  'CHAT_PROVIDER_REJECTED',
  'CHAT_REQUEST_INVALID',
  'CHAT_SCOPE_INVALID',
  'CHAT_UNAVAILABLE',
]);

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export const isProviderFailure = (error: unknown): boolean =>
  error instanceof MultimodalChatProviderError ||
  PROVIDER_FAILURE_CODES.has(errorCode(error) ?? '');

/**
 * A dropped or rejected transfer is not a content defect: rewriting it as one hides
 * the real cause and makes a retryable outage look like a broken template or plan.
 * Provider failures keep their own code and message; everything else becomes the
 * caller's content message.
 */
export const rethrowProviderFailure = (error: unknown, contentMessage: string): never => {
  if (isProviderFailure(error)) throw error;
  throw new Error(contentMessage, { cause: error });
};
