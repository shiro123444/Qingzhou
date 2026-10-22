import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { harnessDigest } from '@lobechat/agent-runtime';

import { learningRoots, ownedLearningDirectory } from './files';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const list = async (directory: string) =>
  readdir(directory).catch((e) => {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return [];
    throw e;
  });
/** Backfill only paths whose existing owner envelope and directory digest agree. */
export async function registerLegacyLearningFiles(userId: string) {
  const [harness, presentation, ...sidecars] = learningRoots();
  for (const key of await list(harness)) {
    if (!/^[a-f\d]{64}$/u.test(key)) continue;
    const filename = path.join(harness, key, 'state.json');
    let state;
    try {
      state = JSON.parse(await readFile(filename, 'utf8'));
    } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) continue;
      throw e;
    }
    if (state.scope?.userId === userId && (await harnessDigest(state.scope)) === key)
      ownedLearningDirectory(userId, harness, key);
  }
  for (const key of await list(presentation)) {
    if (!/^[a-f\d]{64}$/u.test(key)) continue;
    let owned = false;
    for (const kind of ['jobs', 'conversations']) {
      for (const file of await list(path.join(presentation, key, kind))) {
        if (!file.endsWith('.json')) continue;
        const record = JSON.parse(await readFile(path.join(presentation, key, kind, file), 'utf8'));
        if (record.scope?.userId === userId && hash([userId, record.scope.sessionId]) === key)
          owned = true;
      }
    }
    if (owned)
      for (const root of [presentation, ...sidecars.slice(0, 5), sidecars[8]])
        ownedLearningDirectory(userId, root, key);
  }
  for (const root of sidecars.slice(5, 7)) ownedLearningDirectory(userId, root, hash(userId));
  for (const root of [sidecars[7], sidecars[9]])
    ownedLearningDirectory(userId, root, createHash('sha256').update(userId).digest('hex'));
}
