import { spawn } from 'node:child_process';
import { readFile, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Explicit isolated acceptance environment; never inherits a second checkout's database. */
const root = path.resolve('.data/acceptance');
const configuration = parseEnv(await readFile(path.join(root, 'runtime.env'), 'utf8'));
const database = new URL(configuration.DATABASE_URL || 'postgres://invalid/invalid');
if (
  !database.pathname.startsWith('/qingzhou_accept_') ||
  configuration.APP_URL !== 'http://localhost:3310'
)
  throw new Error('ISOLATED_ACCEPTANCE_ENV_REQUIRED');
for (const key of [
  'QINGZHOU_HARNESS_DATA_ROOT',
  'QINGZHOU_LEARNING_LIFECYCLE_ROOT',
  'CORDIS_PRESENTATION_DATA_DIR',
]) {
  if (!path.resolve(configuration[key] || '/').startsWith(root + path.sep))
    throw new Error('ISOLATED_ACCEPTANCE_ROOT_REQUIRED');
}
for (const port of [3310, 9876]) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`ACCEPTANCE_PORT_OCCUPIED:${port}`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
const stop = () => {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const env = { ...process.env, ...configuration };
for (const [name, command] of [
  ['next', ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', '3310']],
  [
    'vite',
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '9876', '--strictPort'],
  ],
] as const) {
  const log = await open(path.join(root, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, command, { env, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  child.once('error', stop);
  child.once('exit', (code) => {
    if (!stopping) {
      console.error(`${name} stopped (${code ?? 'signal'})`);
      process.exitCode = code || 1;
      stop();
    }
  });
  await log.close();
}
console.log('Isolated Qingzhou: http://localhost:3310 (logs under .data/acceptance)');
await Promise.all(
  children.map((child) => new Promise<void>((resolve) => child.once('close', () => resolve()))),
);
