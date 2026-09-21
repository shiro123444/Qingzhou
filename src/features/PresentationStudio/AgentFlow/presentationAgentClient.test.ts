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
