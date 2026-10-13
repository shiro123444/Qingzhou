import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('compact builds select Webpack and propagate bounded resources without changing explicit limits', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qingzhou-build-launcher-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'bin'));
    const launcher = path.join(root, 'scripts/buildCompact.mjs');
    copyFileSync(fileURLToPath(new URL('../buildCompact.mjs', import.meta.url)), launcher);
    writeFileSync(
      path.join(root, 'bin/bun'),
      `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),profile:process.env.QINGZHOU_BUILD_PROFILE,heap:process.env.NODE_OPTIONS,threads:process.env.RAYON_NUM_THREADS,mode:process.env.NODE_ENV}));\n`,
      { mode: 0o700 },
    );
    const run = (args, overrides = {}) =>
      spawnSync(process.execPath, [launcher, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          RAYON_NUM_THREADS: '',
          ...overrides,
          PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        },
      });
    const compact = run(['--next-only'], { RAYON_NUM_THREADS: undefined });
    assert.equal(compact.status, 0, compact.stderr);
    assert.deepEqual(JSON.parse(compact.stdout), {
      args: ['run', 'build:next:compact'],
      cwd: root,
      profile: '8c8g',
      heap: '--max-old-space-size=4096',
      threads: '4',
      mode: 'production',
    });
    const custom = run(['8c8g'], {
      NODE_OPTIONS: '--max_old_space_size=3072',
      RAYON_NUM_THREADS: '1',
    });
    assert.equal(custom.status, 0, custom.stderr);
    const result = JSON.parse(custom.stdout);
    assert.deepEqual(result.args, ['run', 'build:compact:raw']);
    assert.equal(result.heap, '--max_old_space_size=3072');
    assert.equal(result.threads, '1');
    assert.equal(run(['4c4g', '--unknown']).status, 1);
    assert.equal(run(['4c4g']).status, 1);
    assert.equal(run(['unknown']).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
