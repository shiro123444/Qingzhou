import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import type { PresentationJobInput } from '../../../../packages/runtime-contracts/src';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import { attachSourceDocumentImages } from './source-document-images';

const scope = { userId: 'owner', sessionId: 'account' };
const input: PresentationJobInput = {
  title: '汇报',
  notebookId: 'n',
  sourceVersionIds: [],
  options: {
    availableAssetRefs: ['existing-artwork'],
    references: [{ name: '材料.docx', url: 'attachment-report' }],
  },
};
async function source(store: InMemoryPresentationArtifactStore, external = false) {
  const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#124567' } })
    .png()
    .toBuffer();
  await store.put(scope, {
    artifactId: 'attachment-report',
    name: '材料.docx',
    type: 'file',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: zipSync({
      'word/document.xml': strToU8(
        '<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:p><w:r><w:t>招生规模与报考率走势</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:document>',
      ),
      'word/_rels/document.xml.rels': strToU8(
        `<Relationships><Relationship Id="rId1" Target="${external ? 'https://example.com/image.png' : 'media/image1.png'}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
      ),
      'word/media/image1.png': png,
    }),
  });
}
describe('owned source Word images', () => {
  it('keeps a source chart and its context as a reusable asset without losing existing assets', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await source(store);
    const result = await attachSourceDocumentImages(input, { store, scope });
    const refs = result.options?.availableAssetRefs as string[];
    expect(refs[0]).toBe('existing-artwork');
    expect(refs).toHaveLength(2);
    const chart = await store.get(scope, refs[1]);
    expect(chart?.metadata).toMatchObject({
      sourceId: 'attachment-report',
      sourcePart: 'word/media/image1.png',
      origin: 'document',
      width: 24,
      height: 24,
    });
    expect(chart?.name).toContain('招生规模与报考率走势');
    const resumed = await attachSourceDocumentImages(result, { store, scope });
    expect(resumed.options?.availableAssetRefs).toEqual(refs);
  });
  it('does not fetch external Word relationships or expose another account document', async () => {
    const store = new InMemoryPresentationArtifactStore();
    await source(store, true);
    expect(await attachSourceDocumentImages(input, { store, scope })).toBe(input);
    await expect(
      attachSourceDocumentImages(input, {
        store,
        scope: { userId: 'other', sessionId: 'account' },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_SCOPE_MISMATCH' });
  });
  it('honors cancellation before reading source files', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      attachSourceDocumentImages(input, {
        store: new InMemoryPresentationArtifactStore(),
        scope,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
