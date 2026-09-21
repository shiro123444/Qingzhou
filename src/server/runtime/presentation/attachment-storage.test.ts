import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { readPresentationAttachment, uploadPresentationAttachment } from './attachment-storage';

it('persists real attachment bytes, reads their content and isolates accounts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jumi-upload-test-'));
  vi.stubEnv('CORDIS_PRESENTATION_DATA_DIR', root);
  const scope = { userId: 'alice', sessionId: 'presentation-account:alice' };
  const body = new FormData();
  body.append(
    'file',
    new File(['预算37万元，12家门店，8周。'], 'budget.txt', { type: 'text/plain' }),
  );
  try {
    const result = await uploadPresentationAttachment(
      new Request('http://localhost/upload', { method: 'POST', body }),
      scope,
    );
    expect(await readPresentationAttachment(result.id, scope)).toEqual({
      name: 'budget.txt',
      content: '预算37万元，12家门店，8周。',
    });
    await expect(
      readPresentationAttachment(result.id, {
        userId: 'bob',
        sessionId: 'presentation-account:bob',
      }),
    ).rejects.toThrow('不属于');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps uploaded media as an owned reference for native PPTX replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-media-upload-'));
  vi.stubEnv('CORDIS_PRESENTATION_DATA_DIR', root);
  const scope = { userId: 'alice', sessionId: 'presentation-account:alice' };
  const body = new FormData();
  body.append('file', new File([new Uint8Array([1, 2, 3])], 'lesson.mp4'));
  try {
    const result = await uploadPresentationAttachment(
      new Request('http://localhost/upload', { body, method: 'POST' }),
      scope,
    );
    expect(await readPresentationAttachment(result.id, scope)).toEqual({
      content: expect.stringContaining(`mediaRef`),
      name: 'lesson.mp4',
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  }
});
