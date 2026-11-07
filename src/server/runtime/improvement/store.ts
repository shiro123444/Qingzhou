import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { harnessDigest, type HarnessScope } from '@lobechat/agent-runtime';

import { acquireFileExecutionLease } from '../file-lease';
import {
  lifecycleRoot,
  ownedLearningDirectory,
  withAccountData,
} from '../learning-lifecycle/files';

import type { HarnessScopeState, HarnessStore } from './contracts';

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const MAX_SCOPE_BYTES = 16 * 1024 * 1024;
/** Atomic snapshots. Lifecycle-enabled deployments use crash-released OS ownership.
 * Unconfigured legacy deployments retain their explicit stale-lock recovery policy.
 */
export class FileHarnessStore implements HarnessStore {
  constructor(readonly root: string) {}
  private async directory(scope: HarnessScope) {
    if (!scope.userId.trim() || !scope.agentId.trim()) throw new Error('HARNESS_SCOPE_REQUIRED');
    return ownedLearningDirectory(scope.userId, this.root, await harnessDigest(scope));
  }
  async read(scope: HarnessScope): Promise<HarnessScopeState> {
    const dir = await this.directory(scope);
    try {
      if ((await stat(path.join(dir, 'state.json'))).size > MAX_SCOPE_BYTES)
        throw new Error('HARNESS_QUOTA_EXCEEDED');
      const value = JSON.parse(
        await readFile(path.join(dir, 'state.json'), 'utf8'),
      ) as HarnessScopeState;
      if (
        value.schemaVersion !== 1 ||
        value.scope.userId !== scope.userId ||
        value.scope.agentId !== scope.agentId
      )
        throw new Error('HARNESS_STORE_CORRUPT');
      return value;
    } catch (e) {
      if (!missing(e)) throw e;
      return {
        schemaVersion: 1,
        scope: { ...scope },
        revisions: {},
        experiments: {},
        episodes: [],
        decisions: [],
      };
    }
  }
  async transaction<T>(
    scope: HarnessScope,
    run: (state: HarnessScopeState, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const dir = await this.directory(scope);
    return withAccountData(dir, async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const filename = path.join(dir, 'write.lock');
      const lock = lifecycleRoot()
        ? await acquireFileExecutionLease(filename)
        : await open(filename, 'wx', 0o600)
            .then((handle) => ({
              release: async () => {
                await handle.close();
                await unlink(filename);
              },
            }))
            .catch((error) => {
              if (error.code === 'EEXIST') return null;
              throw error;
            });
      if (!lock) throw new Error('HARNESS_BUSY');
      try {
        const state = await this.read(scope);
        const save = async () => {
          const body = JSON.stringify(state);
          if (
            Buffer.byteLength(body) > MAX_SCOPE_BYTES ||
            Object.keys(state.experiments).length > 32 ||
            Object.keys(state.revisions).length > 128 ||
            (state.intents?.length ?? 0) > 128 ||
            (state.instructionProposals?.length ?? 0) > 128
          )
            throw new Error('HARNESS_QUOTA_EXCEEDED');
          const temporary = path.join(dir, `${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
            await rename(temporary, path.join(dir, 'state.json'));
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
        };
        return await run(state, save);
      } finally {
        await lock.release();
      }
    });
  }
  async cancel(scope: HarnessScope, experimentId: string): Promise<void> {
    const state = await this.read(scope);
    if (!Object.hasOwn(state.experiments, experimentId))
      throw new Error('HARNESS_EXPERIMENT_NOT_FOUND');
    const dir = await this.directory(scope);
    const file = path.join(dir, `${await harnessDigest(experimentId)}.cancel`);
    await withAccountData(file, () => writeFile(file, '', { mode: 0o600 }));
  }
  async cancelled(scope: HarnessScope, experimentId: string): Promise<boolean> {
    try {
      await readFile(
        path.join(await this.directory(scope), `${await harnessDigest(experimentId)}.cancel`),
      );
      return true;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  }
}
