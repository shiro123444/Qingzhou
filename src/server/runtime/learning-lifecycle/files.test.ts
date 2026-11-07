// @vitest-environment node
import { registerLegacyLearningFiles } from './legacy';

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireAccountDataLease,
  eraseLearningFiles,
  ownedLearningDirectory,
  pendingLearningErasures,
  requestLearningErasure,
  withAccountData,
} from './files';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'learning-lifecycle-'));
  vi.stubEnv('QINGZHOU_LEARNING_LIFECYCLE_ROOT', path.join(root, 'queue'));
  vi.stubEnv('QINGZHOU_HARNESS_DATA_ROOT', path.join(root, 'harness'));
  vi.stubEnv('CORDIS_PRESENTATION_DATA_DIR', path.join(root, 'presentation'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
describe('owned learning files and account erasure', () => {
  it('waits for OS ownership, blocks late admissions, preserves another account and leaves only an anonymous tombstone', async () => {
    const owned = ownedLearningDirectory(
      'alice',
      process.env.QINGZHOU_HARNESS_DATA_ROOT!,
      hash('alice-scope'),
    );
    const other = ownedLearningDirectory(
      'bob',
      process.env.QINGZHOU_HARNESS_DATA_ROOT!,
      hash('bob-scope'),
    );
    for (const directory of [owned, other]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'state.json'), 'private');
    }
    const lease = await acquireAccountDataLease(owned);
    requestLearningErasure('alice');
    expect(await eraseLearningFiles('alice')).toBe(false);
    await expect(withAccountData(owned, async () => 'late')).rejects.toThrow(
      'LEARNING_ACCOUNT_DELETING',
    );
    expect(await pendingLearningErasures()).toHaveLength(1);
    await lease!.release();
    expect(await eraseLearningFiles('alice')).toBe(true);
    expect((await lstat(owned)).isFile()).toBe(true);
    await expect(mkdir(path.join(owned, 'late'), { recursive: true })).rejects.toBeDefined();
    expect(await readFile(path.join(other, 'state.json'), 'utf8')).toBe('private');
    expect(() =>
      ownedLearningDirectory('alice', process.env.QINGZHOU_HARNESS_DATA_ROOT!, hash('new-scope')),
    ).toThrow('LEARNING_ACCOUNT_DELETING');
    expect(await pendingLearningErasures()).toEqual([]);
    const receipt = await readFile(
      path.join(process.env.QINGZHOU_LEARNING_LIFECYCLE_ROOT!, hash('alice'), 'deleting.json'),
      'utf8',
    );
    expect(receipt).not.toContain('alice');
    expect(JSON.parse(receipt).status).toBe('erased');
  });
  it('does not erase while an admitted asynchronous write drains', async () => {
    const owned = ownedLearningDirectory(
      'alice',
      process.env.QINGZHOU_HARNESS_DATA_ROOT!,
      hash('scope'),
    );
    let entered!: () => void, finish!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const releasePromise = new Promise<void>((r) => {
      finish = r;
    });
    const pending = withAccountData(owned, async () => {
      entered();
      await releasePromise;
      await mkdir(owned, { recursive: true });
      await writeFile(path.join(owned, 'late.json'), 'receipt');
    });
    await enteredPromise;
    requestLearningErasure('alice');
    expect(await eraseLearningFiles('alice')).toBe(false);
    finish();
    await pending;
    expect(await eraseLearningFiles('alice')).toBe(true);
    expect((await lstat(owned)).isFile()).toBe(true);
    await expect(mkdir(path.join(owned, 'late'), { recursive: true })).rejects.toBeDefined();
  });
  it('backfills verified legacy scopes and clears templates and account memories without guessing another owner', async () => {
    const presentation = process.env.CORDIS_PRESENTATION_DATA_DIR!;
    const scopeKey = hash(JSON.stringify(['alice', 'session']));
    const job = path.join(presentation, scopeKey, 'jobs');
    await mkdir(job, { recursive: true });
    await writeFile(
      path.join(job, 'source.json'),
      JSON.stringify({ scope: { userId: 'alice', sessionId: 'session' } }),
    );
    const roots = [
      path.join(presentation, 'templates', scopeKey),
      path.join(presentation, 'capability-memory', hash('alice')),
      path.join(presentation, 'teaching-memory', hash('alice')),
    ];
    for (const directory of roots) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'private.json'), 'private');
    }
    const other = path.join(presentation, 'capability-memory', hash('bob'));
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'private.json'), 'other owner');
    await registerLegacyLearningFiles('alice');
    requestLearningErasure('alice');
    expect(await eraseLearningFiles('alice')).toBe(true);
    for (const directory of roots) expect((await lstat(directory)).isFile()).toBe(true);
    expect(await readFile(path.join(other, 'private.json'), 'utf8')).toBe('other owner');
  });
  it('rejects a tampered ownership index without deleting the target', async () => {
    const owned = ownedLearningDirectory(
      'alice',
      process.env.QINGZHOU_HARNESS_DATA_ROOT!,
      hash('scope'),
    );
    await mkdir(owned, { recursive: true });
    const index = path.join(
      process.env.QINGZHOU_LEARNING_LIFECYCLE_ROOT!,
      hash('alice'),
      'entries',
    );
    const [file] = await readdir(index);
    await writeFile(path.join(index, file), JSON.stringify({ root, key: hash('scope') }));
    requestLearningErasure('alice');
    await expect(eraseLearningFiles('alice')).rejects.toThrow('LEARNING_ERASURE_PATH_REJECTED');
    await expect(access(owned)).resolves.toBeUndefined();
    expect(await pendingLearningErasures()).toHaveLength(1);
  });
});
