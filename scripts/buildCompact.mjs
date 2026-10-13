import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const profiles = {
  '8c8g': { heap: 4096, threads: 4 },
};
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/buildCompact.mjs [8c8g] [--next-only]\nBuild on CI or a build machine; deploy prebuilt artifacts to 4GB servers.',
  );
  process.exit(0);
}
const selected = args.filter((arg) => !arg.startsWith('-'));
const profile = selected[0] ?? '8c8g';
if (
  selected.length > 1 ||
  !Object.hasOwn(profiles, profile) ||
  args.some((arg) => arg.startsWith('-') && arg !== '--next-only')
) {
  console.error('Use the 8c8g build preset; 4c4g is a runtime preset. See --help.');
  process.exit(1);
}
const budget = profiles[profile];
const nodeOptions = process.env.NODE_OPTIONS ?? '';
const hasHeapLimit = /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(nodeOptions);
const child = spawn(
  'bun',
  ['run', args.includes('--next-only') ? 'build:next:compact' : 'build:compact:raw'],
  {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: hasHeapLimit
        ? nodeOptions
        : `${nodeOptions} --max-old-space-size=${budget.heap}`.trim(),
      QINGZHOU_BUILD_PROFILE: profile,
      // Both bundlers use native allocations, which Node's heap limit cannot cap.
      RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS ?? String(budget.threads),
    },
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
});
