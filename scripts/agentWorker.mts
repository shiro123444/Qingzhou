import { createRequire, registerHooks } from 'node:module';

import * as workerLoader from './agentWorkerLoader.mjs';

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
Object.assign(process.env, { NODE_ENV: process.env.NODE_ENV || 'development' });
nextRequire('@next/env').loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
registerHooks(workerLoader);
Object.assign(globalThis, {
  __DEV__: process.env.NODE_ENV !== 'production',
  __TEST__: false,
  __ELECTRON__: false,
  __MOBILE__: false,
});

const preloadExecutors = async () => {
  await import('../src/server/services/agentRuntime/index');
  await (await import('../src/server/runtime/tasks/wakeExecution')).preloadNativeWakeHandlers();
};

if (process.argv.includes('--check')) {
  try {
    await preloadExecutors();
    console.info('[native-agent-worker] Executor modules loaded; no jobs were dispatched');
    process.exit(0);
  } catch (error) {
    let detail = (error as Error).stack ?? String(error);
    for (const [key, value] of Object.entries(process.env))
      if (
        /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL|COOKIE/i.test(key) &&
        value &&
        value.length > 4
      )
        detail = detail.split(value).join('[redacted]');
    console.error('[native-agent-worker] Executor check failed', {
      code: (error as { code?: string }).code,
      name: (error as Error).name,
      detail: detail.split('\n').slice(0, 7),
    });
    process.exit(1);
  }
}

// Complete the shared module graph before either Cordis effect starts polling.
// This is the same cold-start path exercised by --check.
await preloadExecutors();
const { getServerDB } = await import('../packages/database/src/server/index');
const { createNativeAgentWorkerHost } = await import('../src/server/runtime/tasks/production');
const host = createNativeAgentWorkerHost(await getServerDB());
await host.run(async () => undefined);
console.info('[native-agent-worker] Ready; durable steps are claimed from PostgreSQL');

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  try {
    await host.dispose();
    process.exit(0);
  } catch {
    process.exit(1);
  }
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
// Worker timers are unref'd for embedded hosts; the standalone supervisor stays alive.
setInterval(() => undefined, 60_000);
