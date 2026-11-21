import { createHash } from 'node:crypto';

import { PRESENTATION_AGENT_ROLES, type PresentationAgentRole } from './agent-model-config';
import {
  type MultimodalChatContext,
  type MultimodalChatPort,
  MultimodalChatProviderError,
  type MultimodalChatRequest,
  type MultimodalChatUsage,
} from './multimodal-chat-provider';

export { PRESENTATION_AGENT_ROLES, type PresentationAgentRole } from './agent-model-config';

export interface PresentationAgentRoute {
  readonly model: string;
  readonly providerId: string;
  readonly route: 'explicit' | 'default';
}

export interface PresentationAgentExecution {
  readonly configuredModel: string;
  readonly elapsedMs: number;
  readonly errorCode?: string;
  readonly idempotencyKey?: string;
  readonly inputFingerprint: string;
  /** Actual response model, absent when no response was received. */
  readonly model?: string;
  readonly providerId: string;
  readonly resultId?: string;
  readonly role: PresentationAgentRole;
  readonly route: PresentationAgentRoute['route'];
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly traceId?: string;
  readonly usage?: MultimodalChatUsage;
}

export interface PresentationAgentRouter {
  readonly port: (role: PresentationAgentRole) => MultimodalChatPort;
  readonly routes: Readonly<Record<PresentationAgentRole, PresentationAgentRoute>>;
}

/**
 * Roles select already authenticated ports, never request-level model overrides.
 * The workflow remains the sole owner of deck state, checkpoints and scheduling.
 * A missing role uses the explicit default; a failed role never changes provider.
 */
export const createPresentationAgentRouter = (options: {
  readonly defaultPort: MultimodalChatPort;
  readonly ports?: Partial<Record<PresentationAgentRole, MultimodalChatPort>>;
  readonly onExecution?: (
    receipt: PresentationAgentExecution,
    context: MultimodalChatContext,
  ) => void | Promise<void>;
}): PresentationAgentRouter => {
  const routes = {} as Record<PresentationAgentRole, PresentationAgentRoute>;
  const ports = {} as Record<PresentationAgentRole, MultimodalChatPort>;
  const onExecution = options.onExecution;
  for (const role of PRESENTATION_AGENT_ROLES) {
    const configured = options.ports?.[role];
    const delegate = configured ?? options.defaultPort;
    const route = Object.freeze({
      model: delegate.manifest.model,
      providerId: delegate.providerId,
      route: configured ? ('explicit' as const) : ('default' as const),
    });
    routes[role] = route;
    ports[role] = Object.freeze({
      manifest: delegate.manifest,
      providerId: delegate.providerId,
      chat: async (request: MultimodalChatRequest, context: MultimodalChatContext) => {
        const startedAt = Date.now();
        const { model: _requestModel, ...routedRequest } = request;
        const inputFingerprint = createHash('sha256')
          .update(JSON.stringify(routedRequest))
          .digest('hex');
        const report = async (
          completion: Pick<
            PresentationAgentExecution,
            'status' | 'model' | 'errorCode' | 'resultId' | 'usage'
          >,
        ) => {
          if (!onExecution) return;
          const receipt = Object.freeze({
            configuredModel: route.model,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            idempotencyKey: context.idempotencyKey ?? request.idempotencyKey,
            inputFingerprint,
            providerId: route.providerId,
            role,
            route: route.route,
            traceId: context.traceId,
            ...completion,
          });
          try {
            await onExecution(receipt, context);
          } catch {
            // An observer must not make a completed paid inference run again.
            // The workflow owns durable journal recovery, not this model router.
          }
        };
        try {
          if (context.signal?.aborted)
            throw new MultimodalChatProviderError('CHAT_CANCELLED', '模型请求已取消');
          const result = await delegate.chat(routedRequest, context);
          await report({
            model: result.model,
            resultId: result.id,
            status: 'completed',
            usage: result.usage
              ? Object.freeze({
                  completion_tokens: result.usage.completion_tokens,
                  prompt_tokens: result.usage.prompt_tokens,
                  total_tokens: result.usage.total_tokens,
                })
              : undefined,
          });
          return result;
        } catch (error) {
          const cancelled =
            context.signal?.aborted ||
            (error instanceof MultimodalChatProviderError && error.code === 'CHAT_CANCELLED');
          await report({
            errorCode: error instanceof MultimodalChatProviderError ? error.code : 'UNKNOWN',
            status: cancelled ? 'cancelled' : 'failed',
          });
          throw error;
        }
      },
    });
  }
  return Object.freeze({
    port: (role: PresentationAgentRole) => ports[role],
    routes: Object.freeze(routes),
  });
};
