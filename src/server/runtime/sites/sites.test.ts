import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AtomicRuntime } from '../atomic-runtime';
import type { MultimodalChatPort } from '../presentation/multimodal-chat-provider';
import type { Site } from './contracts';
import { createSitesPlugin } from './plugin';
import { sourceOperations } from './sources';
import { SiteStore } from './store';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const owner = { userId: 'alice', sessionId: 'session' };
const article = (text: string, draft = false) =>
  `---\ntitle: "Article"\ndescription: "A blog article"\npublishDate: 2026-10-09\ntags: []\ndraft: ${draft}\n---\n\n${text}\n`;
const path = 'src/content/blog/welcome.md';
async function harness(chat?: MultimodalChatPort) {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-sites-'));
  const store = new SiteStore(root);
  const runtime = new AtomicRuntime([createSitesPlugin(store, chat)]);
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const call = <T = Site>(name: string, input: unknown, scope = owner) =>
    runtime.invoke<T>(name, input, { scope });
  return { store, call, runtime, root };
}

describe('Qingzhou sites on Cordis', () => {
  it('keeps owner isolation and unpublished drafts across restarts', async () => {
    const { store, call, root } = await harness();
    const site = await call('sites.create', { name: 'Alice blog', author: 'Alice' });
    await expect(store.readPublic(site.id)).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    await expect(
      call('sites.read', { id: site.id }, { ...owner, userId: 'bob' }),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    expect(await new SiteStore(root).read(owner.userId, site.id)).toEqual(site);
    expect(await call('sites.list', {}, { ...owner, userId: 'bob' })).toEqual([]);
  });

  it('accepts one concurrent edit and rejects an outdated baseline without overwriting', async () => {
    const { store, call } = await harness();
    const site = await call('sites.create', { name: 'Blog', author: 'Alice' });
    const edits = await Promise.allSettled(
      ['First', 'Second'].map((text) =>
        call('sites.change', {
          id: site.id,
          baseRevision: site.draft.revision,
          changes: { [path]: article(text) },
        }),
      ),
    );
    expect(edits.filter((edit) => edit.status === 'fulfilled')).toHaveLength(1);
    expect(edits.find((edit) => edit.status === 'rejected')).toMatchObject({
      reason: { code: 'SITE_CONFLICT', status: 409 },
    });
    expect((await store.read(owner.userId, site.id)).draft.files[path]).toBe(article('First'));
  });

  it('publishes reviewed content, hides draft articles and rolls back a released version', async () => {
    const { store, call } = await harness();
    const site = await call('sites.create', { name: 'Blog', author: 'Alice' });
    const first = await call('sites.publish', { id: site.id, baseRevision: site.draft.revision });
    const edited = await call('sites.change', {
      id: site.id,
      baseRevision: site.draft.revision,
      changes: {
        [path]: article('Changed'),
        'src/content/blog/private.md': article('Secret draft', true),
      },
    });
    expect((await store.readPublic(site.id)).files[path]).toEqual(site.draft.files[path]);
    const released = await call('sites.publish', {
      id: site.id,
      baseRevision: edited.draft.revision,
    });
    expect(await store.readPublic(site.id)).not.toHaveProperty('ownerId');
    expect((await store.readPublic(site.id)).files).not.toHaveProperty(
      'src/content/blog/private.md',
    );
    const restored = await call('sites.rollback', {
      id: site.id,
      baseRevision: released.draft.revision,
      revision: first.published!.revision,
    });
    expect(restored.published!.files[path]).toEqual(site.draft.files[path]);
    expect(restored.draft.revision).not.toBe(first.draft.revision);
  });

  it('rejects traversal, invalid Astro frontmatter and oversized content', async () => {
    const { call } = await harness();
    const site = await call('sites.create', { name: 'Blog', author: 'Alice' });
    for (const changes of [
      { '../outside.md': article('Attack') },
      { [path]: 'Missing frontmatter' },
      { [path]: article('x'.repeat(210_000)) },
    ]) {
      await expect(
        call('sites.change', { id: site.id, baseRevision: site.draft.revision, changes }),
      ).rejects.toThrow();
    }
    expect((await call('sites.read', { id: site.id })).draft.revision).toBe(site.draft.revision);
  });

  it('saves an agent result only as a draft and checks ownership before contacting the model', async () => {
    let calls = 0;
    const chat = {
      manifest: { model: 'test' },
      chat: async () => {
        calls++;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  changes: { [path]: article('Agent edit') },
                  summary: 'Edited',
                }),
              },
            },
          ],
        };
      },
    } as unknown as MultimodalChatPort;
    const { store, call } = await harness(chat);
    const site = await call('sites.create', { name: 'Blog', author: 'Alice' });
    await expect(
      call(
        'sites.agent.edit',
        { id: site.id, baseRevision: site.draft.revision, instruction: 'Edit' },
        { ...owner, userId: 'bob' },
      ),
    ).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
    expect(calls).toBe(0);
    await call('sites.agent.edit', {
      id: site.id,
      baseRevision: site.draft.revision,
      instruction: 'Edit',
    });
    expect((await store.read(owner.userId, site.id)).draft.files[path]).toBe(article('Agent edit'));
    await expect(store.readPublic(site.id)).rejects.toMatchObject({ code: 'SITE_NOT_FOUND' });
  });

  it('mounts source operations and limits fetching to trusted sources', async () => {
    const urls: string[] = [];
    const operations = sourceOperations(
      [{ id: 'docs', name: 'Docs', url: 'http://localhost:3000' }],
      async (url, options) => {
        urls.push(String(url));
        expect(options?.redirect).toBe('error');
        return Response.json({
          protocol: 'qingzhou.site.v1',
          kind: 'docs',
          content: 'Public knowledge',
        });
      },
    );
    const read = operations.find((operation) => operation.name === 'sites.source.read')!;
    expect(await read.execute({ source: 'docs', slug: 'network' }, { scope: owner })).toMatchObject(
      { content: 'Public knowledge' },
    );
    expect(urls).toEqual(['http://localhost:3000/api/cordis?slug=network']);
    await expect(read.execute({ source: 'blog' }, { scope: owner })).rejects.toMatchObject({
      code: 'SITE_SOURCE_UNAVAILABLE',
    });
    const { runtime } = await harness();
    expect((await runtime.catalog()).map((operation) => operation.name)).toContain('sites.change');
    await runtime.remove('sites');
    expect(await runtime.catalog()).toEqual([]);
  });
});
