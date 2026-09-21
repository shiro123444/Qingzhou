import type { PresentationActivity } from '@/types/presentationActivity';

import type { PresentationConversationResult } from './conversation-capability';

const streamMessage = async (
  message: string,
  send: (value: unknown) => void,
  signal: AbortSignal,
): Promise<void> => {
  const characters = Array.from(message);
  if (characters.length === 0) return;
  const chunkSize = Math.max(1, Math.ceil(characters.length / 24));
  let content = '';
  for (let index = 0; index < characters.length && !signal.aborted; index += chunkSize) {
    const delta = characters.slice(index, index + chunkSize).join('');
    content += delta;
    send({ type: 'message_delta', content, delta });
    if (index + chunkSize < characters.length)
      await new Promise<void>((resolve) => setTimeout(resolve, 12));
  }
};

export const conversationStream = (
  execute: (
    onActivity: (activity: PresentationActivity) => void,
    signal: AbortSignal,
    onCheckpoint: (checkpoint: Pick<PresentationConversationResult, 'brief' | 'slides'>) => void,
  ) => Promise<PresentationConversationResult>,
  dispose: () => Promise<void>,
  requestSignal: AbortSignal,
): Response => {
  const abort = new AbortController();
  const signal = AbortSignal.any([requestSignal, abort.signal]);
  const encoder = new TextEncoder();
  let closed = false;
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (value: unknown) => {
          if (!closed && !signal.aborted)
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        try {
          const result = await execute(
            (activity) => send({ type: 'activity', activity }),
            signal,
            (checkpoint) => send({ type: 'checkpoint', checkpoint }),
          );
          await streamMessage(result.message, send, signal);
          send({ type: 'result', result });
        } catch (error) {
          send({ type: 'error', message: error instanceof Error ? error.message : '创作暂时中断' });
        } finally {
          try {
            await dispose();
          } finally {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        }
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Presentation-Conversation-Version': 'checkpoint-v1',
      },
    },
  );
};
