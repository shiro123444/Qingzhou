import { withAccountData } from '../learning-lifecycle/files';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { trialJson } from './trial-configuration';

const fail = (code: string) => Object.assign(new Error(code), { code });
/** Atomic immutable publication; duplicate identities may only have the same contents. */
export async function writeTrialImmutable(file: string, value: unknown, signal?: AbortSignal) {
  return withAccountData(file, async () => {
    signal?.throwIfAborted();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`,
      text = trialJson(value);
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      signal?.throwIfAborted();
      try {
        await link(temporary, file);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(file, 'utf8')) !== text
        )
          throw fail('PRESENTATION_CONFLICT');
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  });
}
