import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquirePresentationExecutionLease } from './execution-lease';

describe('OS presentation execution lease', () => {
  it('excludes other helpers and allows a new owner after release without deleting lock files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qingzhou-lease-'));
    const file = join(root, 'job.lock');
    const first = await acquirePresentationExecutionLease(file);
    try {
      expect(first).not.toBeNull();
      expect(await acquirePresentationExecutionLease(file)).toBeNull();
      await first!.release();
      expect(first!.signal.aborted).toBe(true);
      const next = await acquirePresentationExecutionLease(file);
      expect(next).not.toBeNull();
      await next!.release();
    } finally {
      await first?.release();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
