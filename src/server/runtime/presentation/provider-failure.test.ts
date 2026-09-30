import { describe, expect, it } from 'vitest';

import { GLMChatProviderError } from './multimodal-chat-provider-glm';
import { isProviderFailure, rethrowProviderFailure } from './provider-failure';

describe('provider failure classification', () => {
  it('treats transport and provider codes as infrastructure, not content', () => {
    expect(isProviderFailure(new GLMChatProviderError('CHAT_UNAVAILABLE', 'interrupted'))).toBe(
      true,
    );
    expect(
      isProviderFailure(Object.assign(new Error('bad request'), { code: 'CHAT_REQUEST_INVALID' })),
    ).toBe(true);
    expect(isProviderFailure(new SyntaxError('Model response was not valid JSON'))).toBe(false);
    expect(isProviderFailure(Object.assign(new Error('no code')))).toBe(false);
    expect(isProviderFailure(undefined)).toBe(false);
  });

  it('keeps a provider failure instead of rewriting it as a content defect', () => {
    const failure = new GLMChatProviderError('CHAT_UNAVAILABLE', '模型连接暂时中断');
    expect(() => rethrowProviderFailure(failure, '模板视觉分析中的组件坐标不可靠')).toThrow(
      failure,
    );
  });

  it('reports content defects with the caller message and preserves the cause', () => {
    const cause = new SyntaxError('Model response was not valid JSON');
    let thrown: unknown;
    try {
      rethrowProviderFailure(cause, '模板视觉分析中的组件坐标不可靠');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('模板视觉分析中的组件坐标不可靠');
    expect((thrown as Error).cause).toBe(cause);
  });
});
