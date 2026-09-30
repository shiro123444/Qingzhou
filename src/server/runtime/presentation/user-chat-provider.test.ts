// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

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
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toMatchObject({
      model: 'selected-alice',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).thinking).toBeUndefined();
    expect(JSON.stringify(port.manifest)).not.toContain('secret');
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

  it('rejects missing scopes, cancelled requests and non-visual models before network access', async () => {
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
    await expect(port.chat(request, { scope })).rejects.toMatchObject({
      code: 'CHAT_REQUEST_INVALID',
    });
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
