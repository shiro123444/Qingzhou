import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import {
  createMultimodalChatPort,
  type MultimodalChatFetcher,
  type MultimodalChatPort,
  MultimodalChatProviderError,
} from './multimodal-chat-provider';

/** Server-only connection resolved from the authenticated user's main-chat settings. */
export interface UserChatConnection {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly provider: string;
  readonly supportsVision: boolean;
}

export const userChatEndpoint = (baseURL: string): string => {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new MultimodalChatProviderError('CHAT_REQUEST_INVALID', '模型服务地址无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new MultimodalChatProviderError(
      'CHAT_REQUEST_INVALID',
      '模型服务需要不含凭证的 HTTPS 地址',
    );
  }
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/chat/completions') ? path : `${path || '/v1'}/chat/completions`;
  return url.toString();
};

/**
 * A scope-dispatched port: no deployment-wide credential, model override, or
 * cross-user response cache. The manifest names a logical selection, not a
 * vendor model; every inference resolves the current saved inbox selection.
 */
export const createUserChatProvider = (options: {
  readonly fetcher: MultimodalChatFetcher;
  /** Text-only capabilities can reuse the saved provider without requiring vision. */
  readonly requiresVision?: boolean;
  readonly resolve: (scope: RuntimeScope) => Promise<UserChatConnection>;
}): MultimodalChatPort => ({
  providerId: 'user-chat-provider',
  manifest: Object.freeze({
    displayName: '主页面模型',
    model: 'inbox',
    providerId: 'user-chat-provider',
    supportsIdempotency: false,
    supportsVision: options.requiresVision !== false,
  }),
  chat: async (request, context) => {
    if (!context?.scope?.userId?.trim() || !context.scope.sessionId?.trim()) {
      throw new MultimodalChatProviderError('CHAT_SCOPE_INVALID', '模型请求缺少用户作用域');
    }
    if (context.signal?.aborted)
      throw new MultimodalChatProviderError('CHAT_CANCELLED', '模型请求已取消');

    let connection: UserChatConnection;
    try {
      connection = await options.resolve(context.scope);
    } catch {
      // DB/decryption/configuration errors can contain secrets. Never surface their text.
      throw new MultimodalChatProviderError(
        'CHAT_PROVIDER_REJECTED',
        '请在模型服务设置中配置并启用主页面使用的 OpenAI 兼容模型',
      );
    }
    if (context.signal?.aborted)
      throw new MultimodalChatProviderError('CHAT_CANCELLED', '模型请求已取消');
    if (options.requiresVision !== false && !connection.supportsVision) {
      throw new MultimodalChatProviderError(
        'CHAT_REQUEST_INVALID',
        'PPT 需要视觉模型，请在主页面选择已启用视觉能力的模型',
      );
    }
    const port = createMultimodalChatPort({
      allowRequestModelOverride: false,
      apiKey: connection.apiKey,
      endpoint: userChatEndpoint(connection.baseURL),
      fetcher: options.fetcher,
      model: connection.model,
      providerId: connection.provider,
    });
    return port.chat(request, context);
  },
});
