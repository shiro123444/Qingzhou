import sharp from 'sharp';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import { createPresentationArtifactAssetStoreBridge } from './asset-store';
import { persistGeneratedImageUrl } from './generated-image-storage';

const scope = { userId: 'owner', sessionId: 'account' };

it('owns provider URL bytes so an expired link is not needed for export or retry', async () => {
  const artifacts = new InMemoryPresentationArtifactStore();
  const store = createPresentationArtifactAssetStoreBridge(artifacts);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'navy' } })
    .png()
    .toBuffer();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes)));
  const uri = 'https://provider.test/image?signature=private';
  const first = await persistGeneratedImageUrl(store, scope, uri, fetcher);
  const second = await persistGeneratedImageUrl(store, scope, uri, fetcher);
  expect(first).toEqual(second);
  expect(first.ref).toMatch(/^image-[a-f0-9]{32}$/u);
  const saved = await artifacts.get(scope, first.ref);
  expect(Buffer.from(saved!.bytes!)).toEqual(bytes);
  expect(JSON.stringify(saved)).not.toContain('signature');
  await expect(
    artifacts.get({ userId: 'other', sessionId: 'account' }, first.ref),
  ).rejects.toMatchObject({ code: 'ARTIFACT_SCOPE_MISMATCH' });
});

it('rejects non-images and oversized bodies without persisting them', async () => {
  const store = createPresentationArtifactAssetStoreBridge(new InMemoryPresentationArtifactStore());
  await expect(
    persistGeneratedImageUrl(
      store,
      scope,
      'https://provider.test/x',
      async () => new Response('<html>expired</html>'),
    ),
  ).rejects.toThrow();
  await expect(
    persistGeneratedImageUrl(
      store,
      scope,
      'https://provider.test/x',
      async () => new Response('x', { headers: { 'content-length': String(20 * 1024 * 1024) } }),
    ),
  ).rejects.toThrow('limit');
});
