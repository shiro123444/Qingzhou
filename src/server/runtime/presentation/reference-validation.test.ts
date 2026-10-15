import sharp from 'sharp';
import { expect, it, vi } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import type { GLMMultimodalChatPort } from './multimodal-chat-provider-glm';
import { createPresentationReferenceValidator } from './reference-validation';

it('recrops a clean region and independently checks its new pixels before returning it', async () => {
  const scope = { userId: 'alice', sessionId: 's' };
  const store = new InMemoryPresentationArtifactStore();
  await store.put(scope, { artifactId: 'branded-crop', type: 'image', name: 'crop.png', mimeType: 'image/png',
    bytes: await sharp({ create: { width: 200, height: 200, channels: 3, background: '#008866' } }).png().toBuffer(),
  });
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async (request) => {
    const parts = request.messages.at(-1)!.content;
    const text = typeof parts === 'string' ? parts : parts.find((part) => part.type === 'text')?.text ?? '';
    const ref = text.split('ref=')[1];
    const original = ref === 'branded-crop';
    return { id: 'check', created: 1, model: 'vision', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ verdicts: [{
      ref, containsText: original, containsIdentityMark: original, contextBoundPhoto: false, reason: original ? '框外旧文字，中心有干净纹理' : '新裁切仅含纹理',
      ...(original ? { safeRegion: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } } : {}),
    }] }) } }] };
  });
  const provider: GLMMultimodalChatPort = { chat, providerId: 'vision', manifest: {
    model: 'vision', providerId: 'vision', displayName: 'Vision', supportsVision: true, supportsIdempotency: true,
  } };
  const validate = createPresentationReferenceValidator({ store, chat: provider });
  const [ref] = await validate(['branded-crop'], { scope });
  expect(ref).toMatch(/^reference-crop-/);
  const derived = await store.get(scope, ref);
  expect(await sharp(derived!.bytes!).metadata()).toMatchObject({ width: 100, height: 100 });
  expect(derived!.metadata?.sourceRef).toBe('branded-crop');
  expect(chat).toHaveBeenCalledTimes(2);
  expect(await validate(['branded-crop'], { scope })).toEqual([ref]);
  expect(chat).toHaveBeenCalledTimes(2);
});

it('checks real owned pixels, excludes identity marks, and caches verdicts against the pixel hash', async () => {
  const scope = { userId: 'alice', sessionId: 's1' };
  const store = new InMemoryPresentationArtifactStore();
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#008866' },
  })
    .png()
    .toBuffer();
  for (const ref of ['texture', 'old-logo'])
    await store.put(scope, {
      artifactId: ref,
      type: 'image',
      name: `${ref}.png`,
      bytes,
      mimeType: 'image/png',
    });
  const chat = vi.fn<GLMMultimodalChatPort['chat']>(async () => ({
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            verdicts: [
              {
                ref: 'texture',
                containsText: false,
                containsIdentityMark: false,
                contextBoundPhoto: false,
                reason: '纯自然纹理',
              },
              {
                ref: 'old-logo',
                containsText: true,
                containsIdentityMark: true,
                contextBoundPhoto: false,
                reason: '有旧机构标识',
              },
            ],
          }),
        },
      },
    ],
    model: 'vision',
    id: 'checked',
    created: 1,
  }));
  const port: GLMMultimodalChatPort = {
    chat,
    providerId: 'vision',
    manifest: {
      model: 'vision',
      providerId: 'vision',
      displayName: 'Vision',
      supportsVision: true,
      supportsIdempotency: true,
    },
  };
  const validate = createPresentationReferenceValidator({ store, chat: port });
  expect(await validate(['texture', 'old-logo'], { scope })).toEqual(['texture']);
  expect(chat.mock.calls[0][1].trustedImages?.urls).toHaveLength(2);
  expect(await validate(['texture', 'old-logo'], { scope })).toEqual(['texture']);
  expect(chat).toHaveBeenCalledOnce();
  await expect(validate(['texture'], { scope: { ...scope, userId: 'bob' } })).rejects.toMatchObject(
    { code: 'ARTIFACT_SCOPE_MISMATCH' },
  );
});
