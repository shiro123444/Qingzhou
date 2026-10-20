import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { PresentationAssetStore } from './asset-store';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Copy expiring provider URLs into the authenticated account's durable asset store. */
export const persistGeneratedImageUrl = async (
  store: PresentationAssetStore,
  scope: RuntimeScope,
  uri: string,
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
) => {
  if (new URL(uri).protocol !== 'https:') throw new Error('Expected an HTTPS image URL');
  const response = await fetcher(uri, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new Error('Generated image download failed');
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds storage limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds storage limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  const metadata = await sharp(bytes, { limitInputPixels: 32_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
    throw new Error('Unsupported generated image format');
  const ref = `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
  const stored = await store.put(scope, {
    asset: { ref },
    bytes,
    idempotencyKey: ref,
    metadata: {
      mimeType: `image/${metadata.format}`,
      sizeBytes: bytes.length,
      providerMetadata: { source: 'download', width: metadata.width, height: metadata.height },
    },
  });
  return { ref: stored.asset.ref };
};
