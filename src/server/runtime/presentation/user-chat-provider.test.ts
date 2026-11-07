// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getOpenCodeGoHeaders } from '@/server/modules/ModelRuntime/opencode-go';

import { createTrustedChatImages } from './multimodal-chat-provider-glm';
import {
  createUserChatProvider,
  type UserChatConnection,
  userChatEndpoint,
} from './user-chat-provider';

const connection = (userId: string): UserChatConnection => ({
  apiKey: `secret-${userId}`,
  baseURL: 'https://cli.tinimodel.com/v1',
  model: `selected-${userId}`,
  provider: 'tini',
  supportsVision: true,
});
const scope = { sessionId: 'session', userId: 'alice' };
const request = {
  messages: [{ content: 'hello', role: 'user' as const }],
  model: 'client-override',
};
const makeFetcher = () =>
  vi.fn(async (_url: string, init: RequestInit) => ({
    json: async () => ({
      choices: [{ message: { content: 'ok', role: 'assistant' } }],
      model: JSON.parse(String(init.body)).model,
    }),
    ok: true,
    status: 200,
  }));

describe('user-scoped presentation provider', () => {
  it('allows text-only site editing while keeping the saved user model', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({
      fetcher,
      requiresVision: false,
      resolve: async () => ({ ...connection('alice'), supportsVision: false }),
    });
    expect((await port.chat(request, { scope })).model).toBe('selected-alice');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(port.manifest.supportsVision).toBe(false);
  });
  it('uses the saved main-chat selection and credentials, never request model overrides', async () => {
    const fetcher = makeFetcher();
    const resolve = vi.fn(async () => connection('alice'));
    const port = createUserChatProvider({ fetcher, resolve });
    const result = await port.chat(request, { scope });
    expect(resolve).toHaveBeenCalledWith(scope);
    expect(result.model).toBe('selected-alice');
    expect(fetcher.mock.calls[0][0]).toBe('https://cli.tinimodel.com/v1/chat/completions');
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer secret-alice',
    });
    expect(new Headers(fetcher.mock.calls[0][1].headers).has('x-opencode-session')).toBe(false);
    expect(new Headers(fetcher.mock.calls[0][1].headers).has('User-Agent')).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({
      model: 'selected-alice',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).thinking).toBeUndefined();
    expect(JSON.stringify(port.manifest)).not.toContain('secret');
  });

  it('adds Go identity without changing authorization, payload or cancellation', async () => {
    const fetcher = makeFetcher();
    const baseURL = 'https://opencode.ai/inference/go/v1';
    const port = createUserChatProvider({
      fetcher,
      resolve: async () => ({ ...connection('alice'), baseURL }),
    });
    const controller = new AbortController();
    await port.chat(request, { scope, signal: controller.signal });
    const [endpoint, init] = fetcher.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(endpoint).toBe(`${baseURL}/chat/completions`);
    for (const [name, value] of Object.entries(getOpenCodeGoHeaders(baseURL, scope)))
      expect(headers.get(name)).toBe(value);
    expect(headers.get('Authorization')).toBe('Bearer secret-alice');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      messages: request.messages,
      model: 'selected-alice',
    });
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it('keeps Go identity stable across calls and separate across users and sessions', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({
      fetcher,
      resolve: async ({ userId }) => ({
        ...connection(userId),
        baseURL: 'https://opencode.ai/inference/go/v1',
      }),
    });
    await port.chat(request, { scope });
    await port.chat(request, { scope: { ...scope } });
    await port.chat(request, { scope: { ...scope, userId: 'bob' } });
    await port.chat(request, { scope: { ...scope, sessionId: 'different-session' } });
    const sessions = fetcher.mock.calls.map(([, init]) =>
      new Headers(init.headers).get('x-opencode-session'),
    );
    expect(sessions[0]).toBeTruthy();
    expect(sessions[1]).toBe(sessions[0]);
    expect(new Set(sessions)).toHaveProperty('size', 3);
  });

  it('isolates concurrent users and picks up saved model/credential changes', async () => {
    const fetcher = makeFetcher();
    let revision = '';
    const port = createUserChatProvider({
      fetcher,
      resolve: async ({ userId }) => connection(`${userId}${revision}`),
    });
    const results = await Promise.all(
      ['alice', 'bob'].map((userId) =>
        port.chat(request, { idempotencyKey: 'same', scope: { ...scope, userId } }),
      ),
    );
    expect(results.map((result) => result.model)).toEqual(['selected-alice', 'selected-bob']);
    revision = '-new';
    expect((await port.chat(request, { scope })).model).toBe('selected-alice-new');
    expect(fetcher.mock.calls.map(([, init]) => init.headers)).toEqual([
      expect.objectContaining({ Authorization: 'Bearer secret-alice' }),
      expect.objectContaining({ Authorization: 'Bearer secret-bob' }),
      expect.objectContaining({ Authorization: 'Bearer secret-alice-new' }),
    ]);
  });

  it('allows PPT text planning with a non-visual DeepSeek model', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({
      fetcher,
      resolve: async () => ({
        ...connection('alice'),
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        provider: 'deepseek',
        supportsVision: false,
      }),
    });
    expect((await port.chat(request, { scope })).model).toBe('deepseek-chat');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('rejects missing scopes, cancelled requests and images on non-visual models before network access', async () => {
    const fetcher = makeFetcher();
    const resolve = vi.fn(async () => ({ ...connection('alice'), supportsVision: false }));
    const port = createUserChatProvider({ fetcher, resolve });
    await expect(port.chat(request, { scope: { ...scope, userId: '' } })).rejects.toMatchObject({
      code: 'CHAT_SCOPE_INVALID',
    });
    await expect(port.chat(request, { scope, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'CHAT_CANCELLED',
    });
    expect(resolve).not.toHaveBeenCalled();
    const imageRequest = {
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'image_url' as const, image_url: { url: 'https://example.com/image.png' } },
          ],
        },
      ],
    };
    await expect(port.chat(imageRequest, { scope })).rejects.toMatchObject({
      code: 'CHAT_REQUEST_INVALID',
      message: expect.stringContaining('此步骤需要读取图片'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects images in a text-only capability even with a visual model', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({
      fetcher,
      requiresVision: false,
      resolve: async () => connection('alice'),
    });
    await expect(
      port.chat(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
            },
          ],
        },
        { scope },
      ),
    ).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not fall back to deployment credentials or expose configuration errors', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({
      fetcher,
      resolve: async () => {
        throw new Error('secret-credential');
      },
    });
    await expect(port.chat(request, { scope })).rejects.toMatchObject({
      code: 'CHAT_PROVIDER_REJECTED',
    });
    await expect(port.chat(request, { scope })).rejects.not.toThrow('secret-credential');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose gateway error bodies that echo credentials or prompts', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'Authorization: Bearer secret-alice; private prompt',
    }));
    const port = createUserChatProvider({ fetcher, resolve: async () => connection('alice') });
    await expect(port.chat(request, { scope })).rejects.toMatchObject({
      code: 'CHAT_REQUEST_INVALID',
      message: 'Multimodal chat provider returned HTTP 400',
    });
  });

  it('retains trusted-image scope validation through the shared provider', async () => {
    const fetcher = makeFetcher();
    const port = createUserChatProvider({ fetcher, resolve: async () => connection('alice') });
    const trustedImages = createTrustedChatImages(
      [
        {
          base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
          mimeType: 'image/png',
        },
      ],
      scope,
    );
    const imageRequest = {
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'image_url' as const, image_url: { url: trustedImages.urls[0] } }],
        },
      ],
    };
    await port.chat(imageRequest, { scope, trustedImages });
    await expect(
      port.chat(imageRequest, { scope: { ...scope, userId: 'bob' }, trustedImages }),
    ).rejects.toMatchObject({ code: 'CHAT_REQUEST_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('shared chat endpoint', () => {
  it.each([
    ['https://cli.tinimodel.com', 'https://cli.tinimodel.com/v1/chat/completions'],
    ['https://cli.tinimodel.com/v1/', 'https://cli.tinimodel.com/v1/chat/completions'],
    ['https://example.com/proxy/v1', 'https://example.com/proxy/v1/chat/completions'],
    ['https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions'],
  ])('normalizes %s without dropping gateway paths', (input, expected) => {
    expect(userChatEndpoint(input)).toBe(expected);
  });
  it.each([
    'invalid',
    'http://example.com',
    'https://key@example.com',
    'https://example.com?key=secret',
    'https://example.com#fragment',
  ])('rejects unsafe endpoint %s', (input) => {
    expect(() => userChatEndpoint(input)).toThrow();
  });
});
