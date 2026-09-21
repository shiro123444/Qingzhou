import { describe, expect, it, vi } from 'vitest';

import { conversationStream } from './conversation-stream';

describe('presentation replacement activity stream', () => {
  it('delivers actual activity before the conversation result is ready', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispose = vi.fn(async () => {});
    const response = conversationStream(
      async (activity) => {
        activity({ operation: 'planning.outline', state: 'started', text: '正在组织逐页大纲' });
        await pending;
        return { brief: {}, message: '大纲已就绪', phase: 'outline', slides: [] };
      },
      dispose,
      new AbortController().signal,
    );
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first)).toMatchObject({
      type: 'activity',
      activity: { operation: 'planning.outline' },
    });
    expect(dispose).not.toHaveBeenCalled();
    finish();
    const events: unknown[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = new TextDecoder().decode(chunk.value);
      for (const line of text.split('\n').filter(Boolean)) events.push(JSON.parse(line));
    }
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'message_delta', content: '大纲已就绪' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'result',
        result: expect.objectContaining({ message: '大纲已就绪' }),
      }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('delivers the last checkpoint even when the next model call fails', async () => {
    const dispose = vi.fn(async () => {});
    const response = conversationStream(
      async (_activity, _signal, checkpoint) => {
        checkpoint({ brief: { topic: '已确认主题', assets: ['saved-artwork'] } });
        throw new Error('upstream unavailable');
      },
      dispose,
      new AbortController().signal,
    );
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        type: 'checkpoint',
        checkpoint: { brief: { topic: '已确认主题', assets: ['saved-artwork'] } },
      },
      { type: 'error', message: 'upstream unavailable' },
    ]);
    expect(response.headers.get('X-Presentation-Conversation-Version')).toBe('checkpoint-v1');
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('aborts work when the reader disconnects and disposes the scoped tools', async () => {
    let signal!: AbortSignal;
    const dispose = vi.fn(async () => {});
    const response = conversationStream(
      async (activity, current) => {
        signal = current;
        activity({ operation: 'context.search', state: 'started', text: '正在搜索相关资料' });
        await new Promise<void>((resolve) =>
          current.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw new Error('cancelled');
      },
      dispose,
      new AbortController().signal,
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
