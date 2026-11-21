import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { FilePresentationStorage } from './file-storage';

it('recovers an older published receipt only from the owning account and the published revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-delivery-'));
  try {
    const store = new FilePresentationStorage(root);
    const scope = { userId: 'owner', sessionId: 'studio' };
    const other = { ...scope, userId: 'other' };
    const origin = { agentId: 'agent', topicId: 'topic', messageId: 'msg' };
    const ids = [
      'job:v1:slide:one',
      'job:v2:artifact:old',
      'job:v2:slide:one',
      'job:v2:artifact:deck',
    ];
    const contents = [
      ['svg', 'v1'],
      ['pptx', 'v1'],
      ['svg', 'v2'],
      ['pptx', 'v2'],
    ];
    for (const [index, id] of ids.entries()) {
      const [type, versionId] = contents[index];
      await store.put(scope, {
        artifactId: id,
        mimeType:
          type === 'svg'
            ? 'image/svg+xml'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: type === 'svg' ? 'cover.svg' : 'deck.pptx',
        type,
        metadata: { jobId: 'job', versionId, slideNumber: 1 },
      });
    }
    await store.saveJob(scope, {
      input: {
        title: 'Example',
        notebookId: 'studio',
        sourceVersionIds: [],
        options: { chatOrigin: origin },
      },
      job: {
        jobId: 'job',
        state: 'completed',
        versionId: 'v2',
        createdAt: '',
        updatedAt: '',
        revisions: [{ versionId: 'v2', artifactIds: ids, createdAt: '' }],
      },
    });
    expect((await store.listJobs(scope))[0].chatOrigin).toEqual(origin);
    expect((await store.getJob(scope, 'job'))?.job).toMatchObject({
      chatOrigin: origin,
      delivery: { coverId: ids[2], pptxId: ids[3], versionId: 'v2' },
    });
    expect(await store.getJob(other, 'job')).toBeNull();
    expect(await store.listJobs(other)).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
