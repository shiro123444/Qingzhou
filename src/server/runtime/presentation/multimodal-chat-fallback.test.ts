import { describe, expect, it, vi } from 'vitest';

import { createFallbackMultimodalChatPort } from './multimodal-chat-fallback';
import {
  type MultimodalChatPort,
  MultimodalChatProviderError,
  type MultimodalChatResult,
} from './multimodal-chat-provider';

const scope = { sessionId: 'session-1', userId: 'user-1' };
const request = { messages: [{ content: 'hello', role: 'user' as const }] };
const result = (id: string): MultimodalChatResult => ({
  choices: [{ index: 0, message: { content: id, role: 'assistant' } }],
  created: 1,
  id,
  model: 'gemini-3.8-flash-high',
});
const port = (chat: MultimodalChatPort['chat'], providerId: string): MultimodalChatPort => ({
  chat,
  manifest: {
    displayName: providerId,
    model: 'gemini-3.8-flash-high',
    providerId,
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId,
});

describe('presentation multimodal chat fallback', () => {
  it('uses the primary provider while it is healthy', async () => {
    const primary = port(
      vi.fn(async () => result('primary')),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );
    const composed = createFallbackMultimodalChatPort(primary, fallback);

    await expect(composed.chat(request, { scope })).resolves.toMatchObject({ id: 'primary' });
    expect(fallback.chat).not.toHaveBeenCalled();
    expect(composed.manifest).toBe(primary.manifest);
  });

  it('uses the fallback after a rate-limit or provider availability failure', async () => {
    const unavailable = new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'HTTP 429');
    const primary = port(
      vi.fn(async () => {
        throw unavailable;
      }),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, { scope }),
    ).resolves.toMatchObject({ id: 'fallback' });
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it('uses the fallback when the primary returns no assistant content or reasoning', async () => {
    const primary = port(
      vi.fn(async () => ({
        choices: [{ index: 0, message: { content: '', role: 'assistant' as const } }],
        created: 1,
        id: 'empty-primary',
        model: 'gemini-3.8-flash-high',
      })),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, { scope }),
    ).resolves.toMatchObject({ id: 'fallback' });
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it('keeps a reasoning-only primary response for structured JSON harvesting', async () => {
    const primary = port(
      vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: '',
              reasoning_content: 'I will emit the JSON in the continuation.',
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'reasoning-primary',
        model: 'gemini-3.8-flash-high',
      })),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, { scope }),
    ).resolves.toMatchObject({ id: 'reasoning-primary' });
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('falls back when a structured continuation still returns reasoning without content', async () => {
    const primary = port(
      vi.fn(async () => ({
        choices: [
          {
            index: 0,
            message: {
              content: '',
              reasoning_content: 'More analysis without the requested object.',
              role: 'assistant' as const,
            },
          },
        ],
        created: 1,
        id: 'reasoning-continuation',
        model: 'gemini-3.8-flash-high',
      })),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, {
        idempotencyKey: 'planner:harvest',
        scope,
      }),
    ).resolves.toMatchObject({ id: 'fallback' });
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it('does not hide authentication, request, or cancellation failures', async () => {
    const rejected = new MultimodalChatProviderError('CHAT_PROVIDER_REJECTED', 'auth rejected');
    const primary = port(
      vi.fn(async () => {
        throw rejected;
      }),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, { scope }),
    ).rejects.toBe(rejected);
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('uses the fallback when a successful upstream response contains malformed JSON', async () => {
    const malformed = new MultimodalChatProviderError(
      'CHAT_PAYLOAD_INVALID',
      'Failed to parse multimodal chat response JSON',
    );
    const primary = port(
      vi.fn(async () => {
        throw malformed;
      }),
      'primary',
    );
    const fallback = port(
      vi.fn(async () => result('fallback')),
      'fallback',
    );

    await expect(
      createFallbackMultimodalChatPort(primary, fallback).chat(request, { scope }),
    ).resolves.toMatchObject({ id: 'fallback' });
    expect(fallback.chat).toHaveBeenCalledOnce();
  });
});

it('returns to the primary if a transient failure is followed by a broken fallback', async () => {
  const primaryChat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValueOnce(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'))
    .mockResolvedValue(result('recovered-primary'));
  const fallbackChat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValue(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'));
  const onRetry = vi.fn();
  const composed = createFallbackMultimodalChatPort(
    port(primaryChat, 'primary'),
    port(fallbackChat, 'fallback'),
    { retryDelayMs: 0 },
  );
  await expect(composed.chat(request, { scope, onRetry })).resolves.toMatchObject({
    id: 'recovered-primary',
  });
  expect(primaryChat).toHaveBeenCalledTimes(2);
  expect(fallbackChat).toHaveBeenCalledOnce();
  expect(onRetry.mock.calls).toEqual([
    [{ attempt: 2, maxAttempts: 3 }],
    [{ attempt: 3, maxAttempts: 3 }],
  ]);
});

it('skips a fallback with rejected credentials without disabling the healthy primary', async () => {
  const primaryChat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValueOnce(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'))
    .mockResolvedValueOnce(result('recovered-primary'))
    .mockRejectedValueOnce(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'))
    .mockResolvedValue(result('recovered-primary'));
  const fallbackChat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValue(new MultimodalChatProviderError('CHAT_PROVIDER_REJECTED', 'auth'));
  const composed = createFallbackMultimodalChatPort(
    port(primaryChat, 'primary'),
    port(fallbackChat, 'fallback'),
    { retryDelayMs: 0 },
  );
  await expect(composed.chat(request, { scope })).resolves.toMatchObject({
    id: 'recovered-primary',
  });
  await expect(composed.chat(request, { scope })).resolves.toMatchObject({
    id: 'recovered-primary',
  });
  expect(fallbackChat).toHaveBeenCalledOnce();
});

it('bounds retries when every channel is unavailable', async () => {
  const chat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValue(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'));
  await expect(
    createFallbackMultimodalChatPort(port(chat, 'primary'), undefined, { retryDelayMs: 0 }).chat(
      request,
      { scope },
    ),
  ).rejects.toMatchObject({ code: 'CHAT_UNAVAILABLE' });
  expect(chat).toHaveBeenCalledTimes(3);
});

it('does not execute another inference after cancellation during recovery', async () => {
  const controller = new AbortController();
  const chat = vi
    .fn<MultimodalChatPort['chat']>()
    .mockRejectedValue(new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'network'));
  await expect(
    createFallbackMultimodalChatPort(port(chat, 'primary'), undefined, { retryDelayMs: 0 }).chat(
      request,
      {
        scope,
        signal: controller.signal,
        onRetry: () => controller.abort(),
      },
    ),
  ).rejects.toThrow();
  expect(chat).toHaveBeenCalledOnce();
});
