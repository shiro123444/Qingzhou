import { describe, expect, it, vi } from 'vitest';

import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { completeStructuredJson, extractModelJson } from './structured-json-chat';

const scope = { sessionId: 's1', userId: 'u1' };
const result = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [
    {
      finish_reason: typeof extra.finish_reason === 'string' ? extra.finish_reason : 'stop',
      index: 0,
      message: {
        content,
        role: 'assistant' as const,
        ...(typeof extra.reasoning_content === 'string'
          ? { reasoning_content: extra.reasoning_content }
          : {}),
      },
    },
  ],
  created: 1,
  id: 'chat',
  model: 'test',
});

const port = (chat: GLMMultimodalChatPort['chat']): GLMMultimodalChatPort => ({
  chat,
  manifest: {
    displayName: 'test',
    model: 'test',
    providerId: 'test',
    supportsIdempotency: true,
    supportsVision: true,
  },
  providerId: 'test',
});

describe('structured JSON chat', () => {
  it('extracts JSON from think tags and mixed prose', () => {
    expect(extractModelJson('<think>draft</think>{"ok":true}')).toEqual({ ok: true });
    expect(extractModelJson('Sure.\n{"ok":true}\nDone.')).toEqual({ ok: true });
  });

  it('keeps a valid first-turn JSON object', async () => {
    const chat = vi.fn(async () => result('{"intents":[]}'));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'intent', scope },
        request: { messages: [{ content: 'plan', role: 'user' }] },
      }),
    ).resolves.toMatchObject({ value: { intents: [] } });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('adds the JSON protocol sentinel required by compatible providers', async () => {
    const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => result('{"ok":true}'));
    const messages = [{ content: 'Review the slide.', role: 'user' as const }];

    await completeStructuredJson({
      chat: port(chat),
      context: { idempotencyKey: 'review', scope },
      request: { messages, response_format: { type: 'json_object' } },
    });

    expect(chat.mock.calls[0][0].messages).toEqual([
      { content: expect.stringMatching(/JSON/u), role: 'system' },
      ...messages,
    ]);
    expect(messages).toEqual([{ content: 'Review the slide.', role: 'user' }]);
  });

  it('harvests JSON after a thinking-only empty content turn', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(result('', { reasoning_content: 'I will pick no new images.' }))
      .mockResolvedValueOnce(result('{"intents":[]}'));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'intent', scope },
        request: { messages: [{ content: 'plan', role: 'user' }] },
      }),
    ).resolves.toMatchObject({ value: { intents: [] } });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][1]).toMatchObject({ idempotencyKey: 'intent:harvest' });
    expect(chat.mock.calls[1][0].messages.at(-1).content).toMatch(/已完成的思考摘要/u);
  });

  it('uses JSON found inside reasoning_content without a second call', async () => {
    const chat = vi.fn(async () => result('', { reasoning_content: 'notes\n{"intents":[]}\nend' }));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'intent', scope },
        request: { messages: [{ content: 'plan', role: 'user' }] },
      }),
    ).resolves.toMatchObject({ value: { intents: [] } });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('repairs JavaScript-flavoured answer syntax without burning a retry', async () => {
    const chat = vi.fn(async () =>
      result('{"slides":[{"slideId":"slide-1",renderer:"image",fidelity:"conceptual"}]}'),
    );
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'content', scope },
        request: { messages: [{ content: 'compile', role: 'user' }] },
      }),
    ).resolves.toMatchObject({
      value: { slides: [{ fidelity: 'conceptual', renderer: 'image', slideId: 'slide-1' }] },
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('repairs a JavaScript-flavoured harvest instead of failing the stage', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(result('', { reasoning_content: 'I will pick a diagram.' }))
      .mockResolvedValueOnce(result("{'intents':[{'id':'visual-1',renderer:'image',},]}"));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'intent', scope },
        request: { messages: [{ content: 'plan', role: 'user' }] },
      }),
    ).resolves.toMatchObject({ value: { intents: [{ id: 'visual-1', renderer: 'image' }] } });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].messages.at(-1).content).toMatch(/双引号/u);
  });

  it('repairs a schema failure in a follow-up turn', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(result('{"intents":"nope"}'))
      .mockResolvedValueOnce(result('{"intents":[]}'));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { idempotencyKey: 'intent', scope },
        parse: (value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !Array.isArray((value as { intents?: unknown }).intents)
          ) {
            throw new Error('intents required');
          }
          return value;
        },
        request: { messages: [{ content: 'plan', role: 'user' }] },
      }),
    ).resolves.toMatchObject({ value: { intents: [] } });
    expect(chat.mock.calls[1][1]).toMatchObject({ idempotencyKey: 'intent:repair' });
  });
});

it('allocates different default inference keys for independent calls in the same session', async () => {
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => result('{"ok":true}'));
  const options = {
    chat: port(chat),
    context: { scope },
    request: { messages: [{ content: 'plan', role: 'user' as const }] },
  };
  await completeStructuredJson(options);
  await completeStructuredJson(options);
  expect(chat.mock.calls[0][1].idempotencyKey).not.toEqual(chat.mock.calls[1][1].idempotencyKey);
});
