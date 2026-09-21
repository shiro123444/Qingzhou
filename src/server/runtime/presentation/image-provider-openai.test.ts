import { describe, expect, it, vi } from 'vitest';

import type {
  ImageGenerationContext,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import {
  createOpenAIImageGenerationPort,
  type OpenAIImageFetcher,
  OpenAIImageProviderError,
} from './image-provider-openai';

const scope: RuntimeScope = { sessionId: 'session-1', userId: 'user-1' };
const otherScope: RuntimeScope = { sessionId: 'session-2', userId: 'user-1' };
const now = () => '2026-08-31T00:00:00.000Z';
const context = (overrides: Partial<ImageGenerationContext> = {}): ImageGenerationContext => ({
  scope,
  ...overrides,
});

const response = (payload: unknown, status = 200): Awaited<ReturnType<OpenAIImageFetcher>> => ({
  json: async () => payload,
  ok: status >= 200 && status < 300,
  status,
});

const optionsFor = (fetcher: OpenAIImageFetcher, overrides: Record<string, unknown> = {}) => ({
  apiKey: 'sk-test-secret',
  endpoint: 'https://images.example.test/v1/images/generations',
  fetcher,
  now,
  ...overrides,
});

describe('C-88 OpenAI-compatible ImageGenerationPort adapter', () => {
  it('maps prompt, size, quality and count to the Images API without exposing the key', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn<OpenAIImageFetcher>(async (_endpoint, init) => {
      expect(init.method).toBe('POST');
      expect(init.signal).toBe(signal);
      expect(init.headers).toEqual({
        'Authorization': 'Bearer sk-test-secret',
        'Content-Type': 'application/json',
      });
      expect(init.body).toBe(
        JSON.stringify({
          model: 'gpt-image-2',
          n: 2,
          prompt: 'a safe prompt',
          quality: 'high',
          size: '1024x1024',
        }),
      );
      return response({
        data: [
          { url: 'https://cdn.example.test/image.png' },
          { url: 'https://cdn.example.test/image-2.png' },
        ],
      });
    });
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));
    const result = await port.generate(
      { count: 2, prompt: 'a safe prompt', quality: 'high', size: '1024x1024' },
      context({ signal }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.asset.ref).toBe('https://cdn.example.test/image.png');
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
  });

  it('projects b64_json into a sink-owned AssetRef and wire-safe metadata', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async () =>
      response({ data: [{ b64_json: 'aGVsbG8=' }] }),
    );
    const assetSink = vi.fn(async ({ bytes, metadata, scope: receivedScope }) => {
      expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
      expect(metadata.sizeBytes).toBe(5);
      expect(receivedScope).toEqual(scope);
      return { ref: 'asset://generated/1' };
    });
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher, { assetSink }));
    const result = await port.generate({ prompt: 'do not return this prompt' }, context());

    expect(result).toEqual([
      {
        asset: { ref: 'asset://generated/1' },
        index: 0,
        metadata: {
          createdAt: now(),
          mimeType: 'image/png',
          providerMetadata: { model: 'gpt-image-2', provider: 'openai.image', source: 'data' },
          sizeBytes: 5,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('do not return this prompt');
    expect(JSON.stringify(result)).not.toContain('aGVsbG8=');
  });

  it('accepts data URL responses and keeps the result free of binary fields', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async () =>
      response({ data: [{ data_url: 'data:image/jpeg;base64,aGVsbG8=' }] }),
    );
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));
    const result = await port.generate({ prompt: 'image' }, context());

    expect(result[0]?.asset.ref).toBe('data:image/jpeg;base64,aGVsbG8=');
    expect(result[0]?.metadata.mimeType).toBe('image/jpeg');
    expect(result[0]).not.toHaveProperty('bytes');
  });

  it('accepts a data URL in the OpenAI url field without invoking a network resolver', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async () =>
      response({ data: [{ url: 'data:image/png;base64,aGVsbG8=' }] }),
    );
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));

    const result = await port.generate({ prompt: 'image' }, context());

    expect(result[0]?.asset.ref).toBe('data:image/png;base64,aGVsbG8=');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the injected URI resolver for HTTPS responses and preserves scope isolation', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async () =>
      response({ data: [{ url: 'https://cdn.example.test/x.png' }] }),
    );
    const resolveAssetUri = vi.fn(async (receivedScope: RuntimeScope, uri: string) => {
      expect(uri).toBe('https://cdn.example.test/x.png');
      return { ref: `asset://${receivedScope.sessionId}/x` };
    });
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher, { resolveAssetUri }));
    const result = await port.generate({ prompt: 'image' }, context());

    expect(result[0]?.asset.ref).toBe('asset://session-1/x');
    expect(resolveAssetUri).toHaveBeenCalledWith(scope, 'https://cdn.example.test/x.png');
    expect(await port.resolveAsset(scope, result[0]!.asset)).toEqual(result[0]?.metadata);
    expect(await port.resolveAsset(otherScope, result[0]!.asset)).toBeNull();
  });

  it('uses the configured provider id and defaults the model to gpt-image-2', () => {
    const fetcher = vi.fn<OpenAIImageFetcher>();
    const port = createOpenAIImageGenerationPort(
      optionsFor(fetcher, { providerId: 'custom.image' }),
    );

    expect(port.providerId).toBe('custom.image');
    expect(port.model).toBe('gpt-image-2');
    expect(port.manifest.providerId).toBe('custom.image');
  });

  it('maps 4xx and 5xx responses without echoing credentials', async () => {
    const rejected = createOpenAIImageGenerationPort(
      optionsFor(vi.fn<OpenAIImageFetcher>(async () => response({}, 429))),
    );
    const unavailable = createOpenAIImageGenerationPort(
      optionsFor(vi.fn<OpenAIImageFetcher>(async () => response({}, 503))),
    );

    await expect(rejected.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_PROVIDER_REJECTED',
    });
    await expect(unavailable.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_UNAVAILABLE',
    });
    try {
      await rejected.generate({ prompt: 'image' }, context());
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAIImageProviderError);
      expect(String(error)).not.toContain('sk-test-secret');
    }
  });

  it('forwards an optional idempotency key as a header rather than request data', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async (_endpoint, init) => {
      expect(init.headers).toMatchObject({ 'Idempotency-Key': 'stable-request-1' });
      expect(init.body).not.toContain('stable-request-1');
      return response({ data: [{ url: 'https://cdn.example.test/image.png' }] });
    });
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));

    await port.generate({ idempotencyKey: 'stable-request-1', prompt: 'image' }, context());
  });

  it('maps non-JSON, missing-image and over-count payloads to IMAGE_PAYLOAD_INVALID', async () => {
    const nonJson = createOpenAIImageGenerationPort(
      optionsFor(vi.fn<OpenAIImageFetcher>(async () => ({ ok: true, status: 200 }))),
    );
    const missingImage = createOpenAIImageGenerationPort(
      optionsFor(vi.fn<OpenAIImageFetcher>(async () => response({ data: [{}] }))),
    );
    const overCount = createOpenAIImageGenerationPort(
      optionsFor(
        vi.fn<OpenAIImageFetcher>(async () =>
          response({
            data: [
              { url: 'https://cdn.example.test/1.png' },
              { url: 'https://cdn.example.test/2.png' },
            ],
          }),
        ),
      ),
    );

    await expect(nonJson.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_PAYLOAD_INVALID',
    });
    await expect(missingImage.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_PAYLOAD_INVALID',
    });
    await expect(
      overCount.generate({ count: 1, prompt: 'image' }, context()),
    ).rejects.toMatchObject({
      code: 'IMAGE_PAYLOAD_INVALID',
    });
  });

  it('cancels before fetch and forwards AbortSignal to the injected fetcher', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<OpenAIImageFetcher>(async () => response({ data: [] }));
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));

    await expect(
      port.generate({ prompt: 'image' }, context({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();

    const activeController = new AbortController();
    const forwardingFetcher = vi.fn<OpenAIImageFetcher>(async (_endpoint, init) => {
      expect(init.signal).toBe(activeController.signal);
      activeController.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const forwardingPort = createOpenAIImageGenerationPort(optionsFor(forwardingFetcher));
    await expect(
      forwardingPort.generate({ prompt: 'image' }, context({ signal: activeController.signal })),
    ).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
  });

  it('rejects invalid request and unsafe URL without making a network call', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async () => response({ data: [] }));
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher));

    await expect(port.generate({ prompt: '' }, context())).rejects.toMatchObject({
      code: 'IMAGE_REQUEST_INVALID',
    });
    await expect(port.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_PAYLOAD_INVALID',
    });
    fetcher.mockResolvedValueOnce(response({ data: [{ url: 'http://cdn.example.test/x.png' }] }));
    await expect(port.generate({ prompt: 'image' }, context())).rejects.toMatchObject({
      code: 'IMAGE_PAYLOAD_INVALID',
    });
  });

  it('sends owned style references through the edits endpoint as multipart images', async () => {
    const fetcher = vi.fn<OpenAIImageFetcher>(async (endpoint, init) => {
      expect(endpoint).toBe('https://images.example.test/v1/images/edits');
      expect(init.headers).toEqual({ Authorization: 'Bearer sk-test-secret' });
      expect(init.body).toBeInstanceOf(FormData);
      const body = init.body as FormData;
      expect(body.get('prompt')).toBe('new watercolor stationery, no text');
      expect(body.get('background')).toBe('opaque');
      expect(body.getAll('image[]')).toHaveLength(1);
      return response({ data: [{ url: 'https://cdn.example.test/styled.png' }] });
    });
    const readReferenceAsset = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'image/png',
    }));
    const port = createOpenAIImageGenerationPort(optionsFor(fetcher, { readReferenceAsset }));
    const result = await port.generate(
      {
        background: 'opaque',
        prompt: 'new watercolor stationery, no text',
        referenceAssetRefs: ['template-page-1'],
      },
      context(),
    );
    expect(result[0]?.asset.ref).toBe('https://cdn.example.test/styled.png');
    expect(readReferenceAsset).toHaveBeenCalledWith(scope, 'template-page-1');
  });

  it('rejects caller-supplied URLs as style references', async () => {
    const port = createOpenAIImageGenerationPort(
      optionsFor(vi.fn(), {
        readReferenceAsset: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
      }),
    );
    await expect(
      port.generate(
        { prompt: 'copy this', referenceAssetRefs: ['https://evil.example/ref.png'] },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_REQUEST_INVALID' });
  });

  it('fails closed when explicit provider credentials are missing', () => {
    const fetcher = vi.fn<OpenAIImageFetcher>();

    expect(() => createOpenAIImageGenerationPort(optionsFor(fetcher, { apiKey: '' }))).toThrow(
      expect.objectContaining({ code: 'IMAGE_UNAVAILABLE' }),
    );
  });
});
