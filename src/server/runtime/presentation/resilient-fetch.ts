import { setTimeout } from 'node:timers/promises';

/** One bounded retry for a broken connection before a response; never retry user cancellation. */
export const createPresentationChatFetch =
  (fetcher: typeof fetch): typeof fetch =>
  async (input, init) => {
    // Provider calls already carry their cancellation/deadline. A shorter hidden timeout
    // used to discard large visual observations before their explicit budget elapsed.
    const signal = init?.signal ?? AbortSignal.timeout(90_000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetcher(input, { ...init, signal });
      } catch (error) {
        if (attempt >= 1 || signal.aborted || !(error instanceof TypeError)) throw error;
        await setTimeout(500, undefined, { signal });
      }
    }
  };
