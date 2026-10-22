import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { acquireFileExecutionLease, type FileExecutionLease } from '../file-lease';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const owners = new Map<string, string>();
export const lifecycleRoot = () => {
  if (process.env.QINGZHOU_LEARNING_LIFECYCLE_ROOT && process.platform === 'win32')
    throw new Error('LEARNING_LIFECYCLE_REQUIRES_POSIX_LOCKS');
  return process.env.QINGZHOU_LEARNING_LIFECYCLE_ROOT;
};
const ownerRoot = (userId: string) => path.join(lifecycleRoot()!, digest(userId));
const fail = () => new Error('LEARNING_ACCOUNT_DELETING');
export function assertAccountActive(userId: string) {
  if (lifecycleRoot() && existsSync(path.join(ownerRoot(userId), 'deleting.json'))) throw fail();
}
function atomicSync(filename: string, value: unknown) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, filename);
}
/** Only trusted storage constructors register paths; no path is accepted from an API request. */
export function ownedLearningDirectory(userId: string, root: string, key: string) {
  if (!/^[a-f\d]{64}$/u.test(key)) throw new Error('LEARNING_OWNER_KEY_INVALID');
  const directory = path.resolve(root, key);
  if (!lifecycleRoot()) return directory;
  assertAccountActive(userId);
  const entry = { ownerHash: digest(userId), root: path.resolve(root), key };
  const filename = path.join(ownerRoot(userId), 'entries', `${digest(directory)}.json`);
  if (
    !existsSync(filename) ||
    JSON.parse(readFileSync(filename, 'utf8')).ownerHash !== entry.ownerHash
  )
    atomicSync(filename, entry);
  assertAccountActive(userId);
  owners.set(directory, userId);
  return directory;
}
function ownerOf(filename: string) {
  const target = path.resolve(filename);
  return [...owners].find(
    ([root]) => target === root || target.startsWith(`${root}${path.sep}`),
  )?.[1];
}
export async function acquireAccountDataLease(
  filename: string,
  signal?: AbortSignal,
): Promise<FileExecutionLease | undefined> {
  const userId = lifecycleRoot() && ownerOf(filename);
  if (!userId) return;
  assertAccountActive(userId);
  const lease = await acquireFileExecutionLease(
    path.join(ownerRoot(userId), 'account.lock'),
    signal,
    true,
  );
  if (!lease) throw fail();
  try {
    assertAccountActive(userId);
    return lease;
  } catch (error) {
    await lease.release();
    throw error;
  }
}
export async function withAccountData<T>(filename: string, run: () => Promise<T>): Promise<T> {
  const lease = await acquireAccountDataLease(filename);
  try {
    return await run();
  } finally {
    await lease?.release();
  }
}
/** Journals expose a synchronous API. Append under the same OS gate rather than racing erasure. */
export function appendAccountJournal(filename: string, text: string) {
  const userId = lifecycleRoot() && ownerOf(filename);
  if (!userId) return false;
  assertAccountActive(userId);
  const result = spawnSync(
    process.env.QINGZHOU_FILE_LOCK_PYTHON ??
      process.env.CORDIS_PPT_PYTHON ??
      (process.platform === 'win32' ? 'python' : 'python3'),
    [
      '-c',
      `
import os, sys
f = open(sys.argv[1], 'a+b')
if os.name == 'nt':
 import msvcrt
 f.write(b'0'); f.flush(); f.seek(0); msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
else:
 import fcntl
 fcntl.flock(f.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
if os.path.exists(sys.argv[2]): sys.exit(3)
fd = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, sys.stdin.buffer.read()); os.close(fd)
`,
      path.join(ownerRoot(userId), 'account.lock'),
      path.join(ownerRoot(userId), 'deleting.json'),
      filename,
    ],
    { input: text, timeout: 15_000, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
  );
  if (result.error || result.status !== 0) throw fail();
  return true;
}
export const hasLearningErasureRequest = (userId: string) =>
  !!lifecycleRoot() && existsSync(path.join(ownerRoot(userId), 'deleting.json'));
export function requestLearningErasure(userId: string) {
  if (!lifecycleRoot()) throw new Error('LEARNING_LIFECYCLE_NOT_CONFIGURED');
  // This tombstone is also the durable recovery queue and remains after erasure.
  const filename = path.join(ownerRoot(userId), 'deleting.json');
  if (!existsSync(filename))
    atomicSync(filename, {
      schemaVersion: 1,
      userId,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
}
export async function pendingLearningErasures() {
  if (!lifecycleRoot()) return [];
  const dirs = await readdir(lifecycleRoot()!).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const pending: { userId: string; directory: string }[] = [];
  for (const dir of dirs.filter((d) => /^[a-f\d]{64}$/u.test(d))) {
    const directory = path.join(lifecycleRoot()!, dir);
    const file = path.join(directory, 'deleting.json');
    if (!existsSync(file)) continue;
    const job = JSON.parse(await readFile(file, 'utf8'));
    if (job.status === 'pending' && typeof job.userId === 'string' && digest(job.userId) === dir)
      pending.push({ userId: job.userId, directory });
    if (pending.length >= 16) break;
  }
  return pending;
}
export function learningRoots() {
  const presentation = path.resolve(
    process.env.CORDIS_PRESENTATION_DATA_DIR || '.data/presentation',
  );
  return [
    path.resolve(process.env.QINGZHOU_HARNESS_DATA_ROOT || '.data/harness'),
    presentation,
    ...[
      'trial-learning',
      'trial-evidence',
      'trial-tasks',
      'trial-validation',
      'trial-validation/sealed-evidence',
      'trial-runs/runs',
      'trial-serial',
      'capability-memory',
      'templates',
      'teaching-memory',
    ].map((d) => path.join(presentation, d)),
  ];
}
/** Holds the exclusive account gate until all owned paths and their index have been removed. */
export async function eraseLearningFiles(userId: string) {
  const directory = ownerRoot(userId);
  if (!existsSync(path.join(directory, 'deleting.json')))
    throw new Error('LEARNING_ERASURE_NOT_REQUESTED');
  const lease = await acquireFileExecutionLease(path.join(directory, 'account.lock'));
  if (!lease) return false; // In-flight work must drain; a later tick retries.
  try {
    const entries = await readdir(path.join(directory, 'entries')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of entries) {
      if (!/^[a-f\d]{64}\.json$/u.test(name)) continue;
      const entry = JSON.parse(await readFile(path.join(directory, 'entries', name), 'utf8'));
      if (
        entry.ownerHash !== digest(userId) ||
        !learningRoots().includes(entry.root) ||
        !/^[a-f\d]{64}$/u.test(entry.key)
      )
        throw new Error('LEARNING_ERASURE_PATH_REJECTED');
      const target = path.join(entry.root, entry.key);
      if (name !== `${digest(target)}.json`) throw new Error('LEARNING_ERASURE_PATH_REJECTED');
      // Reject symlinked ancestors; rm itself never follows links inside an owned directory.
      for (
        let parent = entry.root;
        parent !== path.dirname(parent);
        parent = path.dirname(parent)
      ) {
        if (existsSync(parent) && (await lstat(parent)).isSymbolicLink())
          throw new Error('LEARNING_ERASURE_PATH_REJECTED');
      }
      mkdirSync(entry.root, { recursive: true, mode: 0o700 });
      // Leave a non-directory fence at the old root. Even an uncooperative late writer
      // cannot recreate child paths after its helper/parent has died.
      const prefix = `.erasing-${entry.key}-`;
      let fenced = false;
      for (let attempt = 0; attempt < 16; attempt++) {
        const info = await lstat(target).catch((error) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (info?.isFile() && info.size === 0) {
          fenced = true;
          break;
        }
        if (info) await rename(target, path.join(entry.root, `${prefix}${randomUUID()}`));
        try {
          writeFileSync(target, '', { flag: 'wx', mode: 0o600 });
          fenced = true;
          break;
        } catch (error) {
          if (!['EEXIST', 'EISDIR'].includes((error as NodeJS.ErrnoException).code || ''))
            throw error;
        }
      }
      if (!fenced) throw new Error('LEARNING_ERASURE_WRITER_NOT_QUIESCENT');
      // Also recover quarantine directories left by a previous worker crash.
      for (const name of await readdir(entry.root)) {
        if (name.startsWith(prefix) && /^[a-f\d-]{36}$/u.test(name.slice(prefix.length)))
          await rm(path.join(entry.root, name), { recursive: true, force: true });
      }
    }
    await rm(path.join(directory, 'entries'), { recursive: true, force: true });
    for (const name of await readdir(directory))
      if (/^deleting\.json\.[a-f\d-]{36}\.tmp$/u.test(name))
        await rm(path.join(directory, name), { force: true });
    atomicSync(path.join(directory, 'deleting.json'), {
      schemaVersion: 1,
      status: 'erased',
      completedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    await lease.release();
  }
}
