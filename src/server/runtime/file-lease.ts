import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface FileExecutionLease {
  release: () => Promise<void>;
  readonly signal: AbortSignal;
}

// OS locks survive event-loop stalls and are released on process death. The
// helper owns only a lock descriptor; EOF on its parent pipe releases it too.
// The configured local lock helper is an explicit storage capability. No daemon,
// expiring lock or stale-file deletion is needed.
const LOCK_HELPER = `
import os, sys
f = open(sys.argv[1], 'a+b')
if os.fstat(f.fileno()).st_size == 0:
    f.write(b'0'); f.flush()
f.seek(0)
try:
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(f.fileno(), (fcntl.LOCK_SH if sys.argv[2] == 'shared' else fcntl.LOCK_EX) | fcntl.LOCK_NB)
except OSError:
    print('busy', flush=True)
    sys.exit(3)
print('acquired', flush=True)
sys.stdin.buffer.read()
f.close()
`;

export async function acquireFileExecutionLease(
  filename: string,
  signal?: AbortSignal,
  shared = false,
): Promise<FileExecutionLease | null> {
  signal?.throwIfAborted();
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.env.QINGZHOU_FILE_LOCK_PYTHON ??
      process.env.CORDIS_PPT_PYTHON ??
      (process.platform === 'win32' ? 'python' : 'python3'),
    ['-u', '-c', LOCK_HELPER, filename, shared ? 'shared' : 'exclusive'],
    {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
  const lost = new AbortController();
  child.stdin.on('error', () => undefined);
  let released = false;
  let acquired = false;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      if (acquired && !released)
        lost.abort(
          Object.assign(new Error('Execution ownership was lost'), {
            code: 'FILE_EXECUTION_LEASE_LOST',
          }),
        );
      resolve();
    }),
  );
  const stop = () => child.kill();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            Object.assign(new Error('Execution ownership check timed out'), {
              code: 'FILE_EXECUTION_LEASE_UNAVAILABLE',
            }),
          ),
        15_000,
      );
      let output = '';
      const finish = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('\n')) finish(output.trim());
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(Object.assign(error, { code: 'FILE_EXECUTION_LEASE_UNAVAILABLE' }));
      });
      child.once('close', () => {
        clearTimeout(timeout);
        if (!output.trim())
          reject(
            Object.assign(new Error('Execution ownership helper stopped'), {
              code: 'FILE_EXECUTION_LEASE_UNAVAILABLE',
            }),
          );
      });
    });
    signal?.throwIfAborted();
    if (result === 'busy') {
      await closed;
      return null;
    }
    if (result !== 'acquired') throw new Error('Invalid execution ownership response');
    acquired = true;
    return {
      signal: lost.signal,
      release: async () => {
        released = true;
        lost.abort(
          Object.assign(new Error('Execution lease released'), {
            code: 'FILE_EXECUTION_LEASE_LOST',
          }),
        );
        signal?.removeEventListener('abort', stop);
        child.stdin.end();
        await closed;
      },
    };
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  } finally {
    if (!acquired) signal?.removeEventListener('abort', stop);
  }
}
