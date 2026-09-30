import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPresentationAgentClient } from './presentationAgentClient';

const encoder = new TextEncoder();

describe('presentationAgentClient conversation stream', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies a checkpoint before surfacing a later stream error', async () => {
    const checkpoint = { brief: { topic: '已确认主题', assets: ['saved-artwork'] } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        [
          JSON.stringify({ type: 'checkpoint', checkpoint }),
          JSON.stringify({ type: 'error', message: 'upstream unavailable' }),
        ].join('\n'),
        { headers: { 'content-type': 'application/x-ndjson' } },
      ),
    );
    const onCheckpoint = vi.fn();
    await expect(
      createPresentationAgentClient().turn(
        { messages: [], references: [], threadId: 'thread-1' },
        { onCheckpoint },
      ),
    ).rejects.toThrow('upstream unavailable');
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith(checkpoint);
  });

  it('forwards assistant message deltas before resolving the final result', async () => {
    const payloads = [
      { type: 'message_delta', delta: '模', content: '模' },
      { type: 'message_delta', delta: '板', content: '模板' },
      {
        type: 'result',
        result: { brief: {}, message: '模板', phase: 'intake' },
      },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of payloads)
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
        status: 200,
      }),
    );
    const deltas: string[] = [];

    const result = await createPresentationAgentClient().turn(
      { messages: [], references: [], threadId: 'thread-1' },
      { onMessageDelta: (_delta, content) => deltas.push(content) },
    );

    expect(deltas).toEqual(['模', '模板']);
    expect(result).toMatchObject({ message: '模板', phase: 'intake' });
  });
});

it('ends an idle stream while retaining already delivered checkpoints', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const onCheckpoint = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: 'checkpoint', checkpoint: { brief: { topic: 'saved' } } }) + '\n',
        ),
      );
    },
    cancel,
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
    );
  try {
    const pending = createPresentationAgentClient({
      idleTimeoutMs: 100,
      totalTimeoutMs: 1000,
    }).turn({ messages: [], references: [], threadId: 't' }, { onCheckpoint });
    const rejected = expect(pending).rejects.toThrow('连接长时间无响应');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(onCheckpoint).toHaveBeenCalledWith({ brief: { topic: 'saved' } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    fetch.mockRestore();
    vi.useRealTimers();
  }
});

it('heartbeats reset idle time but cannot bypass the total deadline', async () => {
  vi.useFakeTimers();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
  });
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
    );
  try {
    const pending = createPresentationAgentClient({ idleTimeoutMs: 100, totalTimeoutMs: 250 }).turn(
      { messages: [], references: [], threadId: 't' },
    );
    const rejected = expect(pending).rejects.toThrow('本轮处理超时');
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(80);
      output.enqueue(encoder.encode('{"type":"heartbeat"}\n'));
    }
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    fetch.mockRestore();
    vi.useRealTimers();
  }
});
