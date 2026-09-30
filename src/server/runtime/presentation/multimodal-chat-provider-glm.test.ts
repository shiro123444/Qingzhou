// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import {
  assertSafeImageUrl,
  createGLMMultimodalChatPort,
  createTrustedChatImages,
  type GLMChatFetcher,
  GLMChatProviderError,
  type GLMChatRequest,
} from './multimodal-chat-provider-glm';

const response = (
  payload: unknown,
  status = 200,
  ok = status >= 200 && status < 300,
): Awaited<ReturnType<GLMChatFetcher>> => ({
  json: async () => payload,
  ok,
  status,
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

describe('server-owned visual references', () => {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const url = `data:image/png;base64,${base64}`;
  const request: GLMChatRequest = {
    messages: [{ content: [{ image_url: { url }, type: 'image_url' }], role: 'user' }],
  };

  it('permits exactly the scoped images from a process-local server permission', async () => {
    const fetcher = vi.fn(async (_endpoint: string, _init: RequestInit) =>
      response({ choices: [{ message: { content: 'A teal product', role: 'assistant' } }] }),
    );
    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
    const trustedImages = createTrustedChatImages(
      [{ base64, mimeType: 'image/png' }],
      defaultScope,
    );
    await expect(port.chat(request, { scope: defaultScope, trustedImages })).resolves.toMatchObject(
      { choices: [{ message: { content: 'A teal product' } }] },
    );
    expect(
      JSON.parse(vi.mocked(fetcher).mock.calls[0][1].body as string).messages[0].content[0]
        .image_url.url,
    ).toBe(url);
    await expect(
      port.chat(request, { scope: { ...defaultScope, sessionId: 'other-session' }, trustedImages }),
    ).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('continues rejecting JSON-supplied data URLs or forged permissions', async () => {
    const fetcher = vi.fn();
    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
    await expect(port.chat(request, { scope: defaultScope })).rejects.toMatchObject({
      code: 'CHAT_REQUEST_INVALID',
    });
    const trustedImages = createTrustedChatImages(
      [{ base64, mimeType: 'image/png' }],
      defaultScope,
    );
    await expect(
      port.chat(request, {
        scope: defaultScope,
        trustedImages: JSON.parse(JSON.stringify(trustedImages)),
      }),
    ).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
    await expect(
      port.chat(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
              ],
            },
          ],
        },
        { scope: defaultScope, trustedImages },
      ),
    ).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects forged MIME types, malformed base64 and excessive trusted payloads', () => {
    expect(() =>
      createTrustedChatImages([{ base64, mimeType: 'image/jpeg' }], defaultScope),
    ).toThrow('MIME type');
    expect(() =>
      createTrustedChatImages([{ base64: 'not-base64', mimeType: 'image/png' }], defaultScope),
    ).toThrow('bounded');
    expect(() =>
      createTrustedChatImages(
        Array.from({ length: 7 }, () => ({ base64, mimeType: 'image/png' as const })),
        defaultScope,
      ),
    ).toThrow('six images');
    expect(() =>
      createTrustedChatImages(
        [{ base64: 'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4), mimeType: 'image/png' }],
        defaultScope,
      ),
    ).toThrow('bounded');
  });
});

const defaultScope: RuntimeScope = {
  sessionId: 'test-session',
  userId: 'test-user',
};

const defaultOptions = (fetcher: GLMChatFetcher) => ({
  apiKey: 'secret-test-token-12345',
  endpoint: 'https://api.b.ai/v1/chat/completions',
  fetcher,
  model: 'glm-5.3-flash',
  now: () => 1700000000000,
});

describe('GLMMultimodalChatAdapter (C-106)', () => {
  it('sends OpenAI-compatible chat completions requests with bearer authorization', async () => {
    let capturedEndpoint = '';
    let capturedInit: RequestInit | undefined;

    const fetcher: GLMChatFetcher = vi.fn(async (endpoint, init) => {
      capturedEndpoint = endpoint;
      capturedInit = init;
      return response({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: 'Hello! I am GLM-5.3-Flash.',
              role: 'assistant',
            },
          },
        ],
        created: 1700000000,
        id: 'chatcmpl-test-123',
        model: 'glm-5.3-flash',
        usage: {
          completion_tokens: 10,
          prompt_tokens: 15,
          total_tokens: 25,
        },
      });
    });

    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

    const result = await port.chat(
      {
        messages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello GLM', role: 'user' },
        ],
        temperature: 0.7,
      },
      { scope: defaultScope },
    );

    expect(capturedEndpoint).toBe('https://api.b.ai/v1/chat/completions');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-test-token-12345',
    );
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );

    const body = JSON.parse(capturedInit?.body as string);
    expect(body.model).toBe('glm-5.3-flash');
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toBeUndefined();
    expect(body.messages).toEqual([
      { content: 'You are a helpful assistant', role: 'system' },
      { content: 'Hello GLM', role: 'user' },
    ]);

    expect(result.id).toBe('chatcmpl-test-123');
    expect(result.choices[0].message.content).toBe('Hello! I am GLM-5.3-Flash.');
    expect(result.usage?.total_tokens).toBe(25);
  });

  it('preserves empty content and reasoning_content for thinking models', async () => {
    const fetcher: GLMChatFetcher = vi.fn(async () =>
      response({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: '',
              reasoning_content: 'I will return JSON next.',
              role: 'assistant',
            },
          },
        ],
        id: 'chatcmpl-reasoning',
      }),
    );
    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
    await expect(
      port.chat({ messages: [{ content: 'plan', role: 'user' }] }, { scope: defaultScope }),
    ).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: '',
            reasoning_content: 'I will return JSON next.',
          },
        },
      ],
    });
  });

  it('supports multimodal vision content with safe remote image URLs', async () => {
    let capturedBody: any;
    const fetcher: GLMChatFetcher = vi.fn(async (_endpoint, init) => {
      capturedBody = JSON.parse(init.body as string);
      return response({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content: 'I see a presentation slide diagram.', role: 'assistant' },
          },
        ],
        id: 'chatcmpl-vision-1',
        model: 'glm-5.3-flash',
      });
    });

    const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

    const result = await port.chat(
      {
        messages: [
          {
            content: [
              { text: 'Please analyze this slide:', type: 'text' },
              {
                image_url: { detail: 'high', url: 'https://cdn.example.com/slide-preview.png' },
                type: 'image_url',
              },
            ],
            role: 'user',
          },
        ],
      },
      { scope: defaultScope },
    );

    expect(capturedBody.messages[0].content).toEqual([
      { text: 'Please analyze this slide:', type: 'text' },
      {
        image_url: { detail: 'high', url: 'https://cdn.example.com/slide-preview.png' },
        type: 'image_url',
      },
    ]);
    expect(result.choices[0].message.content).toBe('I see a presentation slide diagram.');
  });

  describe('Security invariants: strictly reject data URIs, file URIs, local paths, and base64', () => {
    it.each([
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'DATA:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD',
      'file:///home/shiro/secret.png',
      'FILE:///C:/Windows/System32/config.sys',
      'blob:https://app.lobehub.com/1234-5678',
      '/tmp/upload.png',
      '\\server\\share\\image.png',
      'https://example.com/image?payload=base64data',
    ])('rejects unsafe image url: %s', (unsafeUrl) => {
      expect(() => assertSafeImageUrl(unsafeUrl)).toThrowError(GLMChatProviderError);
    });

    it('rejects chat request containing unsafe image URL', async () => {
      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat(
          {
            messages: [
              {
                content: [
                  { text: 'Analyze this', type: 'text' },
                  {
                    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
                    type: 'image_url',
                  },
                ],
                role: 'user',
              },
            ],
          },
          { scope: defaultScope },
        ),
      ).rejects.toThrowError(GLMChatProviderError);

      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('Scope isolation, idempotency, timeout and cancellation', () => {
    it('does not reuse an earlier inference when the request changes under the same key', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({ choices: [{ message: { content: 'outline', role: 'assistant' } }] }),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
      const context = { idempotencyKey: 'outline', scope: defaultScope };
      await port.chat({ messages: [{ content: 'First topic', role: 'user' }] }, context);
      await port.chat({ messages: [{ content: 'Revised topic', role: 'user' }] }, context);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not cache empty responses and block a later successful retry', async () => {
      const fetcher = vi
        .fn<GLMChatFetcher>()
        .mockResolvedValueOnce(
          response({ choices: [{ message: { content: '', role: 'assistant' } }] }),
        )
        .mockResolvedValueOnce(
          response({ choices: [{ message: { content: 'Recovered', role: 'assistant' } }] }),
        );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
      const context = { idempotencyKey: 'retry', scope: defaultScope };
      const request: GLMChatRequest = { messages: [{ content: 'Continue', role: 'user' }] };
      await port.chat(request, context);
      await expect(port.chat(request, context)).resolves.toMatchObject({
        choices: [{ message: { content: 'Recovered' } }],
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('keeps transport diagnostics in cause while returning a safe recoverable message', async () => {
      const failure = new TypeError('fetch failed: sensitive upstream diagnostics');
      const fetcher = vi.fn<GLMChatFetcher>().mockRejectedValue(failure);
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
      const error = await port
        .chat({ messages: [{ content: 'Continue', role: 'user' }] }, { scope: defaultScope })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'CHAT_UNAVAILABLE', cause: failure });
      expect((error as Error).message).not.toContain('sensitive');
    });

    it('preserves user cancellation while reading the response body', async () => {
      const controller = new AbortController();
      const fetcher = vi.fn<GLMChatFetcher>(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          controller.abort();
          throw new TypeError('body interrupted');
        },
      }));
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));
      await expect(
        port.chat(
          { messages: [{ content: 'Continue', role: 'user' }] },
          { scope: defaultScope, signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'CHAT_CANCELLED' });
    });

    it('requires valid scope with userId and sessionId', async () => {
      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: { sessionId: '', userId: 'u1' } as any },
        ),
      ).rejects.toThrowError(/scope/);

      await expect(
        port.chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: { sessionId: 's1', userId: '   ' } as any },
        ),
      ).rejects.toThrowError(/scope/);
    });

    it('returns cached result on idempotent replay within the same scope', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({
          choices: [{ index: 0, message: { content: 'Idempotent response', role: 'assistant' } }],
          id: 'chatcmpl-idemp',
        }),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const req: GLMChatRequest = {
        idempotencyKey: 'key-123',
        messages: [{ content: 'Generate outline', role: 'user' }],
      };

      const res1 = await port.chat(req, { idempotencyKey: 'key-123', scope: defaultScope });
      const res2 = await port.chat(req, { idempotencyKey: 'key-123', scope: defaultScope });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(res1).toBe(res2);

      // Different scope with same key must not share cache
      const otherScope: RuntimeScope = { sessionId: 'other-session', userId: 'other-user' };
      await port.chat(req, { idempotencyKey: 'key-123', scope: otherScope });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('maps AbortSignal cancellation to CHAT_CANCELLED', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetcher = vi.fn<GLMChatFetcher>();
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: defaultScope, signal: controller.signal },
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_CANCELLED');
    });

    it('enforces timeoutMs and maps a timed out request to CHAT_UNAVAILABLE', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(
        async (_endpoint, init) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat(
          { messages: [{ content: 'Hi', role: 'user' }] },
          { scope: defaultScope, timeoutMs: 5 },
        ),
      ).rejects.toMatchObject({ code: 'CHAT_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('maps 401/403 to CHAT_PROVIDER_REJECTED without leaking API key', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response({ error: { message: 'Invalid API key secret-test-token-12345' } }, 401, false),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope })
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_PROVIDER_REJECTED');
      expect(err.message).not.toContain('secret-test-token-12345');
    });

    it('maps 429/503 to CHAT_UNAVAILABLE', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () => response('Overloaded', 503, false));
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      const err = await port
        .chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope })
        .catch((e) => e);

      expect(err).toBeInstanceOf(GLMChatProviderError);
      expect(err.code).toBe('CHAT_UNAVAILABLE');
    });

    it('accepts a gateway SSE envelope for a successful non-stream request', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () =>
        response(
          `data: ${JSON.stringify({ choices: [{ message: { content: 'recovered' } }] })}\n\ndata: [DONE]\n`,
        ),
      );
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope }),
      ).resolves.toMatchObject({ choices: [{ message: { content: 'recovered' } }] });
    });

    it('classifies an empty successful provider body as a recoverable payload failure', async () => {
      const fetcher = vi.fn<GLMChatFetcher>(async () => response(''));
      const port = createGLMMultimodalChatPort(defaultOptions(fetcher));

      await expect(
        port.chat({ messages: [{ content: 'Hi', role: 'user' }] }, { scope: defaultScope }),
      ).rejects.toMatchObject({ code: 'CHAT_PAYLOAD_INVALID' });
    });
  });
});
