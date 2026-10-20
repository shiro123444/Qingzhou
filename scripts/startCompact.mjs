import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const budgets = { '4c4g': 1024, '8c8g': 2048 };
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/startCompact.mjs [4c4g|8c8g] [--check]\nRuns a prebuilt production server. PORT defaults to 3210; models use configured external providers.',
  );
  process.exit(0);
}
const require = createRequire(import.meta.url);
const nextRequire = createRequire(
  require.resolve('next/package.json', {
    paths: [root, path.join(root, '.next/standalone')],
  }),
);
const { loadEnvConfig } = nextRequire('@next/env');

loadEnvConfig(root, false);
const selected = args.filter((arg) => !arg.startsWith('-'));
const profile = selected[0] ?? process.env.QINGZHOU_SERVER_PROFILE ?? '4c4g';
if (
  selected.length > 1 ||
  !Object.hasOwn(budgets, profile) ||
  args.some((arg) => arg.startsWith('-') && arg !== '--check')
) {
  console.error('Choose 4c4g or 8c8g; use --help for supported options.');
  process.exit(1);
}
const standalone = path.join(root, '.next/standalone/server.js');
const completeBuild = (directory) => {
  try {
    if (!readFileSync(path.join(directory, '.next/BUILD_ID'), 'utf8').trim()) return false;
    // BUILD_ID is written before static generation; a failed build can leave it behind.
    for (const name of [
      'routes-manifest.json',
      'prerender-manifest.json',
      'server/app-paths-manifest.json',
    ]) {
      const value = JSON.parse(readFileSync(path.join(directory, '.next', name), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    }
    return true;
  } catch {
    return false;
  }
};
const hasStandalone = existsSync(standalone) && completeBuild(path.dirname(standalone));
const built = hasStandalone || completeBuild(root);
if (args.includes('--check')) {
  console.log(
    JSON.stringify(
      {
        profile,
        defaultHeapMiB: budgets[profile],
        productionBuild: built,
        mode: hasStandalone ? 'standalone' : 'next-start',
      },
      null,
      2,
    ),
  );
  process.exit(built ? 0 : 1);
}
if (!built) {
  console.error(
    'No production build. Build on a development/CI machine and deploy the artifacts first.',
  );
  process.exit(1);
}
const nodeOptions = process.env.NODE_OPTIONS ?? '';
const hasHeapLimit = /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(nodeOptions);
const command = hasStandalone
  ? [standalone]
  : [require.resolve('next/dist/bin/next'), 'start', '-p', process.env.PORT ?? '3210'];
const serverDirectory = hasStandalone ? path.dirname(standalone) : root;
const serverEnvironment = {
  ...process.env,
  NODE_ENV: 'production',
  NODE_OPTIONS: hasHeapLimit
    ? nodeOptions
    : `${nodeOptions} --max-old-space-size=${budgets[profile]}`.trim(),
  QINGZHOU_SERVER_PROFILE: profile,
  // Next's standalone server changes cwd to its generated directory.
  // Keep durable account data outside .next, including relative user settings.
  CORDIS_PRESENTATION_DATA_DIR: path.resolve(
    root,
    process.env.CORDIS_PRESENTATION_DATA_DIR || '.data/presentation',
  ),
  CORDIS_SITES_DATA_DIR: path.resolve(root, process.env.CORDIS_SITES_DATA_DIR || '.data/sites'),
  PORT: process.env.PORT ?? '3210',
};
// On supported Linux Node releases, discard the launcher heap and retain one service PID.
// Keep a portable fallback and an opt-out for hosts that restrict POSIX exec.
if (
  process.platform === 'linux' &&
  typeof process.execve === 'function' &&
  process.env.QINGZHOU_SPAWN_SERVER !== '1'
) {
  process.chdir(serverDirectory);
  process.execve(process.execPath, [process.execPath, ...command], serverEnvironment);
}
const child = spawn(process.execPath, command, {
  cwd: serverDirectory,
  env: serverEnvironment,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
});
