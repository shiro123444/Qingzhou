// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { expect, it } from 'vitest';

async function child(directory: string, mode: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(
    (resolve, reject) => {
      const process = spawn(
        globalThis.process.execPath,
        ['--import', 'tsx', 'tests/fixtures/nativeAgentCrash.mts', directory, mode],
        {
          env: {
            ...globalThis.process.env,
            NODE_ENV: 'test',
            DATABASE_URL: 'postgres://fixture@127.0.0.1:1/native_fixture',
            KEY_VAULTS_SECRET: randomBytes(32).toString('base64'),
            REDIS_URL: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      process.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      process.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });
      process.once('error', reject);
      process.once('close', (code, signal) => resolve({ code, signal, output }));
    },
  );
}

for (const mode of ['claimed', 'dispatched', 'committed'])
  it(`recovers ${mode} work after SIGKILL with a new native host and no duplicate effect`, async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-native-crash-'));
    try {
      const crashed = await child(directory, mode);
      expect(crashed.signal, crashed.output).toBe('SIGKILL');
      const restarted = await child(directory, 'recover');
      expect(restarted.code, restarted.output).toBe(0);
      const line = restarted.output
        .split('\n')
        .find((item) => item.startsWith('NATIVE_CRASH_REPORT '));
      expect(line, restarted.output).toBeDefined();
      const report = JSON.parse(line!.slice('NATIVE_CRASH_REPORT '.length));
      expect(report.effects).toEqual(mode === 'committed' ? [0, 1] : [0]);
      expect(report.jobs.map((job: { status: string }) => job.status)).toEqual(
        mode === 'dispatched' ? ['unknown'] : mode === 'committed' ? ['done', 'done'] : ['done'],
      );
      expect(report.status).toBe(mode === 'dispatched' ? 'interrupted' : 'done');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

for (const mode of ['wake-queued', 'wake-claimed', 'wake-dispatched', 'wake-committed'])
  it(`retains ${mode} across a real process kill without duplicating its effect`, async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-wake-crash-'));
    try {
      const crashed = await child(directory, mode);
      expect(crashed.signal, crashed.output).toBe('SIGKILL');
      if (mode === 'wake-queued') await new Promise((resolve) => setTimeout(resolve, 600));
      const restarted = await child(directory, 'recover-wake');
      expect(restarted.code, restarted.output).toBe(0);
      const line = restarted.output
        .split('\n')
        .find((item) => item.startsWith('NATIVE_CRASH_REPORT '));
      expect(line, restarted.output).toBeDefined();
      const report = JSON.parse(line!.slice('NATIVE_CRASH_REPORT '.length));
      expect(report.effects).toEqual([0]);
      expect(report.jobs[0].status).toBe(mode === 'wake-dispatched' ? 'unknown' : 'done');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
