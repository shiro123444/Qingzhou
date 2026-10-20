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
  it.each([true, false])(
    'validates the alternate model after a failed schema repair (valid=%s)',
    async (valid) => {
      const primary = vi.fn(async () => result('{"ok":false}'));
      const fallback = vi.fn(async () => result(JSON.stringify({ ok: valid })));
      const parse = vi.fn((value: any) => {
        if (!value.ok) throw new Error('required native table missing');
        return value;
      });
      const promise = completeStructuredJson({
        chat: port(primary),
        fallbackChat: port(fallback),
        context: { scope, idempotencyKey: 'table' },
        parse,
        request: {
          messages: [{ role: 'user', content: 'Use the source facts and retain every row.' }],
        },
      });
      if (valid) await expect(promise).resolves.toMatchObject({ value: { ok: true } });
      else await expect(promise).rejects.toThrow('required native table missing');
      expect(primary).toHaveBeenCalledTimes(2);
      expect(fallback).toHaveBeenCalledOnce();
      expect(parse).toHaveBeenCalledTimes(3);
    },
  );
  it('harvests an empty schema repair and preserves the validation error and source facts', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(result('{"ok":false}'))
      .mockResolvedValueOnce(result('', { reasoning_content: '按校验意见重新整理版式' }))
      .mockResolvedValueOnce(result('{"ok":true}'));
    const parse = vi.fn((value: any) => {
      if (!value.ok) throw new Error('内容必须位于统一正文区');
      return value;
    });
    await expect(
      completeStructuredJson({
        chat: port(chat),
        context: { scope, idempotencyKey: 'repair-page' },
        parse,
        request: { messages: [{ role: 'user', content: '沿用录取68人的原始资料' }] },
      }),
    ).resolves.toMatchObject({ value: { ok: true } });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[2][1].idempotencyKey).toBe('repair-page:repair:harvest');
    const context = JSON.stringify(chat.mock.calls[2][0].messages);
    expect(context).toContain('内容必须位于统一正文区');
    expect(context).toContain('录取68人');
  });
  it('uses the configured alternate model after empty continuations and keeps the same source context', async () => {
    const primary = vi.fn<GLMMultimodalChatPort['chat']>(async () =>
      result('', { reasoning_content: '第四页的真实资料已核对' }),
    );
    const fallback = vi.fn<GLMMultimodalChatPort['chat']>(async () =>
      result('{"slides":[{"slideId":"slide-4"}]}'),
    );
    await expect(
      completeStructuredJson({
        chat: port(primary),
        fallbackChat: port(fallback),
        context: { scope, idempotencyKey: 'fourth-page' },
        request: { messages: [{ role: 'user', content: '沿用已读资料，只继续第四页' }] },
      }),
    ).resolves.toMatchObject({ value: { slides: [{ slideId: 'slide-4' }] } });
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fallback.mock.calls[0][0].messages)).toContain(
      '沿用已读资料，只继续第四页',
    );
    expect(fallback.mock.calls[0][1]).toMatchObject({
      scope,
      idempotencyKey: 'fourth-page:fallback',
    });
  });
  it('continues after two empty responses without discarding prior reasoning', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(result('', { reasoning_content: '已完成这一页的数据与布局规划' }))
      .mockResolvedValueOnce(result('', { reasoning_content: '继续整理该页的图表和文字' }))
      .mockResolvedValueOnce(result('{"slides":[{"slideId":"slide-4"}]}'));
    const completed = await completeStructuredJson({
      chat: port(chat),
      context: { scope, idempotencyKey: 'page-4' },
      request: { messages: [{ role: 'user', content: '只制作第四页' }] },
    });
    expect(completed.value).toEqual({ slides: [{ slideId: 'slide-4' }] });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(chat.mock.calls[2][0].max_tokens).toBe(32000);
    expect(JSON.stringify(chat.mock.calls[2][0].messages)).toContain(
      '已完成这一页的数据与布局规划',
    );
    expect(chat.mock.calls[2][1].idempotencyKey).toBe('page-4:harvest-2');
  });

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

  it('continues through the configured fallback when transport rejects a fully empty response', async () => {
    const chat = vi
      .fn<GLMMultimodalChatPort['chat']>()
      .mockRejectedValue(
        Object.assign(new Error('Empty response'), { code: 'CHAT_PAYLOAD_INVALID' }),
      );
    const fallback = vi.fn<GLMMultimodalChatPort['chat']>(async () => result('{"ok":true}'));
    await expect(
      completeStructuredJson({
        chat: port(chat),
        fallbackChat: port(fallback),
        context: { scope, idempotencyKey: 'page-4' },
        request: {
          messages: [{ content: 'Keep this page and its source material', role: 'user' }],
        },
      }),
    ).resolves.toMatchObject({ value: { ok: true } });
    expect(chat).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0][1].idempotencyKey).toBe('page-4:fallback');
    expect(fallback.mock.calls[0][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Keep this page and its source material',
          role: 'user',
        }),
      ]),
    );
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
