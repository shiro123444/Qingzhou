import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilePresentationStorage } from './file-storage';

const scope = { userId: 'owner', sessionId: 'workspace' };
const roots: string[] = [];

async function stores() {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-presence-'));
  roots.push(root);
  return [new FilePresentationStorage(root), new FilePresentationStorage(root)];
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const target = path.resolve(root);
    if (!target.startsWith(path.join(path.resolve(tmpdir()), 'qingzhou-presence-')))
      throw new Error('Unexpected temporary presence directory');
    await rm(target, { recursive: true, force: true });
  }
});

describe('shared presence tab updates', () => {
  it('keeps a foreground peer when another writer reports its own background tab', async () => {
    const [first, second] = await stores();
    const now = Date.now();
    await first.savePresence(scope, 'job', [{ tabId: 'foreground', active: true, seenAt: now }]);
    await second.savePresence(scope, 'job', [{ tabId: 'background', active: false, seenAt: now }]);
    expect(await first.readPresence(scope, 'job')).toEqual(
      expect.arrayContaining([
        { tabId: 'foreground', active: true, seenAt: now },
        { tabId: 'background', active: false, seenAt: now },
      ]),
    );
  });

  it('does not lose concurrent tab updates from independent storage instances', async () => {
    const storesByWriter = await stores();
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        storesByWriter[index % 2].savePresence(scope, 'job', [
          { tabId: `tab-${index}`, active: index === 0, seenAt: now },
        ]),
      ),
    );
    const tabs = await storesByWriter[0].readPresence(scope, 'job');
    expect(new Set(tabs.map(({ tabId }) => tabId)).size).toBe(16);
    expect(tabs.find(({ tabId }) => tabId === 'tab-0')?.active).toBe(true);
  });

  it('updates only the named tab, preserving peer tabs and account/task boundaries', async () => {
    const [first, second] = await stores();
    const now = Date.now();
    await first.savePresence(scope, 'job', [{ tabId: 'a', active: true, seenAt: now }]);
    await second.savePresence(scope, 'job', [{ tabId: 'b', active: true, seenAt: now }]);
    await first.savePresence(scope, 'job', [{ tabId: 'a', active: false, seenAt: now }]);
    expect(await first.readPresence(scope, 'job')).toEqual(
      expect.arrayContaining([
        { tabId: 'a', active: false, seenAt: now },
        { tabId: 'b', active: true, seenAt: now },
      ]),
    );
    expect(await first.readPresence({ ...scope, userId: 'someone-else' }, 'job')).toEqual([]);
    expect(await first.readPresence(scope, 'different-job')).toEqual([]);
  });

  it('ignores expired and future-dated observations', async () => {
    const [store] = await stores();
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    await store.savePresence(scope, 'job', [
      { tabId: 'expired', active: true, seenAt: 55_000 },
      { tabId: 'fresh', active: true, seenAt: 55_001 },
      { tabId: 'future', active: true, seenAt: 100_001 },
    ]);
    expect(await store.readPresence(scope, 'job')).toEqual([
      { tabId: 'fresh', active: true, seenAt: 55_001 },
    ]);
  });
});
