// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearXNGClient } from './client';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('SearXNGClient', () => {
  let client: SearXNGClient;

  beforeEach(() => {
    client = new SearXNGClient('https://searxng.example.com');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return results on successful response', async () => {
    const mockResponse = {
      answers: [],
      corrections: [],
      infoboxes: [],
      number_of_results: 1,
      query: 'test',
      results: [{ title: 'Test', url: 'https://example.com' }],
      suggestions: [],
      unresponsive_engines: [],
    };

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve(mockResponse),
      ok: true,
    });

    const result = await client.search('test');
    expect(result).toEqual(mockResponse);
  });

  it('should throw error with HTTP status when response is not ok (e.g. 500)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(client.search('杭州天气')).rejects.toThrow('Failed to search: HTTP 500');
  });

  it('should not read or include response body in HTTP error message', async () => {
    const textFn = vi.fn().mockResolvedValue('sensitive config or html');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: textFn,
    });

    await expect(client.search('test')).rejects.toThrow('Failed to search: HTTP 500');
    expect(textFn).not.toHaveBeenCalled();
  });

  it('should throw error with numeric status for 502 Bad Gateway', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
    });

    await expect(client.search('test')).rejects.toThrow('Failed to search: HTTP 502');
  });
});
