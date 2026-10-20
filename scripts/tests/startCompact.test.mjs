import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qingzhou-compact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await cp(
    path.join(project, 'scripts/startCompact.mjs'),
    path.join(root, 'scripts/startCompact.mjs'),
  );
  await symlink(path.join(project, 'node_modules'), path.join(root, 'node_modules'));
  return root;
}
async function manifests(directory) {
  await mkdir(path.join(directory, '.next/server'), { recursive: true });
  await writeFile(path.join(directory, '.next/BUILD_ID'), 'test-build');
  for (const name of [
    'routes-manifest.json',
    'prerender-manifest.json',
    'server/app-paths-manifest.json',
  ])
    await writeFile(path.join(directory, '.next', name), '{}');
}
function run(root, args, extra = {}) {
  const env = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', ...extra };
  if (!Object.hasOwn(extra, 'CORDIS_PRESENTATION_DATA_DIR'))
    delete env.CORDIS_PRESENTATION_DATA_DIR;
  if (!Object.hasOwn(extra, 'CORDIS_SITES_DATA_DIR')) delete env.CORDIS_SITES_DATA_DIR;
  return spawnSync(process.execPath, [path.join(root, 'scripts/startCompact.mjs'), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('BUILD_ID left by a failed prerender is not accepted as a production build', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.next'));
  await writeFile(path.join(root, '.next/BUILD_ID'), 'incomplete');
  const result = run(root, ['4c4g', '--check']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).productionBuild, false);
});

test('standalone keeps durable data rooted outside .next and preserves explicit directories', async (t) => {
  const root = await fixture(t);
  const standalone = path.join(root, '.next/standalone');
  await manifests(standalone);
  await writeFile(
    path.join(standalone, 'server.js'),
    `
    process.chdir(__dirname);
    console.log(JSON.stringify({
      pid: process.pid,
      cwd: process.cwd(), sites: process.env.CORDIS_SITES_DATA_DIR,
      presentation: process.env.CORDIS_PRESENTATION_DATA_DIR, heap: process.env.NODE_OPTIONS,
    }));
  `,
  );
  const defaults = run(root, ['4c4g']);
  assert.equal(defaults.status, 0, defaults.stderr);
  const first = JSON.parse(defaults.stdout);
  if (process.platform === 'linux' && typeof process.execve === 'function')
    assert.equal(first.pid, defaults.pid, 'the launcher is replaced instead of remaining resident');
  assert.equal(first.cwd, standalone);
  assert.equal(first.sites, path.join(root, '.data/sites'));
  assert.equal(first.presentation, path.join(root, '.data/presentation'));
  assert.match(first.heap, /--max-old-space-size=1024/);

  const absolute = path.join(root, 'owned-presentation-data');
  const configured = run(root, ['8c8g'], {
    CORDIS_PRESENTATION_DATA_DIR: absolute,
    CORDIS_SITES_DATA_DIR: 'content/blog',
  });
  assert.equal(configured.status, 0, configured.stderr);
  const second = JSON.parse(configured.stdout);
  assert.equal(second.presentation, absolute);
  assert.equal(second.sites, path.join(root, 'content/blog'));
  assert.match(second.heap, /--max-old-space-size=2048/);

  const fallback = run(root, ['4c4g'], { QINGZHOU_SPAWN_SERVER: '1' });
  assert.equal(fallback.status, 0, fallback.stderr);
  const spawned = JSON.parse(fallback.stdout);
  assert.notEqual(spawned.pid, fallback.pid);
  assert.equal(spawned.sites, path.join(root, '.data/sites'));
  assert.match(spawned.heap, /--max-old-space-size=1024/);
});
