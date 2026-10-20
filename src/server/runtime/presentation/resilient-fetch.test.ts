import { describe, expect, it, vi } from 'vitest';

import { createPresentationChatFetch } from './resilient-fetch';

describe('presentation chat connection recovery', () => {
  it('honors the provider deadline instead of introducing a shorter transport deadline', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await createPresentationChatFetch(fetcher)('https://example.test', {
      signal: controller.signal,
    });
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
  it('recovers a single failed connection without retrying a received response', async () => {
    const response = new Response('{}', { status: 200 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(response);
    expect(
      await createPresentationChatFetch(fetcher)('https://example.test', { method: 'POST' }),
    ).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never retries a cancelled generation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      createPresentationChatFetch(fetcher)('https://example.test', { signal: controller.signal }),
    ).rejects.toThrow('fetch failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
