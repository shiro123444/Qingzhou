import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from '../artifact-store';
import type { GLMMultimodalChatPort } from '../multimodal-chat-provider-glm';
import { prepareFrameAperture } from './frame-aperture';

it('removes original picture pixels while retaining the frame, caches the derived image, and enforces ownership', async () => {
  const scope = { userId: 'alice', sessionId: 's' };
  const store = new InMemoryPresentationArtifactStore();
  await store.put(scope, { artifactId: 'filled-frame', type: 'image', name: 'frame.png', mimeType: 'image/png',
    bytes: await sharp({ create: { width: 100, height: 100, channels: 3, background: '#16294b' } }).png().toBuffer(),
    metadata: { templateId: 'source-template' },
  });
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({ id: 'aperture', created: 1, model: 'vision',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
      aperture: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, outsideIdentityOrText: false, reason: '可分离相框',
    }) } }],
  }));
  const provider: GLMMultimodalChatPort = { chat, providerId: 'vision', manifest: {
    model: 'vision', providerId: 'vision', displayName: 'Vision', supportsVision: true, supportsIdempotency: true,
  } };
  const input = { ref: 'filled-frame', scope, store, chat: provider };
  const result = await prepareFrameAperture(input);
  const derived = (await store.get(scope, result.ref))!;
  const { data } = await sharp(derived.bytes!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(data[(50 * 100 + 50) * 4 + 3]).toBe(0);
  expect(data[3]).toBe(255);
  expect(derived.metadata).toMatchObject({ templateId: 'source-template', extraction: 'frame-aperture' });
  expect(await prepareFrameAperture(input)).toEqual(result);
  expect(chat).toHaveBeenCalledOnce();
  await expect(prepareFrameAperture({ ...input, scope: { ...scope, userId: 'bob' } })).rejects.toMatchObject({ code: 'ARTIFACT_SCOPE_MISMATCH' });
});
