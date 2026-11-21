import { readFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';

import { drizzle } from 'drizzle-orm/pglite';

import * as loader from '../../scripts/agentWorkerLoader.mjs';

registerHooks(loader);
Object.assign(globalThis, {
  __DEV__: false,
  __TEST__: true,
  __ELECTRON__: false,
  __MOBILE__: false,
});
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');

const [directory, mode] = process.argv.slice(2);
if (
  !directory ||
  ![
    'claimed',
    'dispatched',
    'committed',
    'recover',
    'wake-queued',
    'wake-claimed',
    'wake-dispatched',
    'wake-committed',
    'recover-wake',
  ].includes(mode)
)
  throw new Error('Invalid crash fixture arguments');

const { NativeAgentStore } = await import('../../src/server/runtime/tasks/store');
const { PostgresAgentStateManager } =
  await import('../../src/server/modules/AgentRuntime/PostgresAgentStateManager');
const { NativeAgentWorker } = await import('../../src/server/runtime/tasks/worker');
const { AgentRuntime } = await import('@lobechat/agent-runtime');
const { CordisProfileLoader } = await import('@lobechat/cordis-runtime');
const client = new PGlite(directory);
const db = drizzle(
  client,
) as unknown as import('../../packages/database/src/type').LobeChatDatabase;
const store = new NativeAgentStore(db);
const manager = new PostgresAgentStateManager(db);
if (mode.startsWith('wake-') || mode === 'recover-wake') {
  const { NativeWakeStore } = await import('../../src/server/runtime/tasks/wakeStore');
  const { NativeWakeWorker } = await import('../../src/server/runtime/tasks/wakeWorker');
  const wakes = new NativeWakeStore(db);
  if (mode !== 'recover-wake') {
    await client.exec(
      "CREATE TABLE users (id text PRIMARY KEY); INSERT INTO users VALUES ('owner'); CREATE TABLE native_test_effects (id serial PRIMARY KEY, step integer NOT NULL);",
    );
    await client.exec(
      await readFile(
        new URL('../../packages/database/migrations/0115_native_agent_wake.sql', import.meta.url),
        'utf8',
      ),
    );
    await wakes.enqueue({
      kind: 'agent-signal',
      userId: 'owner',
      key: 'wake',
      scopeKey: 'wake',
      payload: {},
      availableAt: new Date(Date.now() + (mode === 'wake-queued' ? 500 : 0)),
    });
    if (mode !== 'wake-queued') {
      const job = (await wakes.claim())!;
      const lease = { id: job.id, owner: job.leaseOwner! };
      if (mode !== 'wake-claimed') {
        await wakes.dispatch(lease);
        await client.exec('INSERT INTO native_test_effects(step) VALUES (0)');
      }
      if (mode === 'wake-committed') await wakes.finish(lease, { completed: true });
      await client.exec(
        "UPDATE agent_wake_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE status IN ('claimed','dispatched')",
      );
    }
    await client.exec('CHECKPOINT');
    process.kill(process.pid, 'SIGKILL');
  } else {
    const worker = new NativeWakeWorker(wakes, async (_job, guard) => {
      guard.assertHeld();
      await client.exec('INSERT INTO native_test_effects(step) VALUES (0)');
      return { receipt: { completed: true } };
    });
    const host = new CordisProfileLoader({
      bundles: { base: { entries: [{ id: 'wake', use: 'wake' }] } },
      modules: {
        wake: {
          plugin: {
            apply(ctx) {
              ctx.provide('fixture.wake', worker);
              ctx.effect(() => worker.start());
            },
          },
        },
      },
      profile: { bundles: ['base'] },
    });
    await host.run(async () => worker.tick());
    await host.dispose();
    const jobs = await client.query('SELECT status FROM agent_wake_jobs');
    const effects = await client.query('SELECT step FROM native_test_effects ORDER BY id');
    console.info(
      'NATIVE_CRASH_REPORT ' +
        JSON.stringify({
          jobs: jobs.rows,
          effects: effects.rows.map((row: { step: number }) => row.step),
        }),
    );
    await client.close();
  }
  process.exit(0);
}
const state = (stepCount: number, status: 'running' | 'done') =>
  AgentRuntime.createInitialState({
    operationId: 'op',
    metadata: { userId: 'owner' },
    stepCount,
    status,
  });
const message = (stepIndex: number) => ({
  operationId: 'op',
  stepIndex,
  delay: 0,
  endpoint: 'http://fixture.invalid/api/agent/run',
});

if (mode !== 'recover') {
  await client.exec(`CREATE TABLE users (id text PRIMARY KEY);
    INSERT INTO users VALUES ('owner');
    CREATE TABLE agent_operations (id text, user_id text, status text, completion_reason text,
      interruption jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), accessed_at timestamptz DEFAULT now());
    CREATE TABLE native_test_effects (id serial PRIMARY KEY, step integer NOT NULL);`);
  await client.exec(
    await readFile(
      new URL('../../packages/database/migrations/0114_native_agent_runtime.sql', import.meta.url),
      'utf8',
    ),
  );
  await manager.createOperationMetadata('op', { userId: 'owner' });
  await manager.saveAgentState('op', state(0, 'running'));
  await store.enqueue('owner', message(0));
  const job = (await store.claim())!;
  if (mode !== 'claimed') {
    await store.dispatch({ id: job.id, owner: job.leaseOwner! });
    await client.exec('INSERT INTO native_test_effects(step) VALUES (0)');
  }
  if (mode === 'committed') {
    const lease = (await manager.acquireStepLease('op', 0))!;
    const next = state(1, 'running');
    next.metadata!._pendingNextStep = message(1);
    await manager.saveStepResultWithLease(
      'op',
      { stepIndex: 0, newState: next, executionTime: 1 },
      lease,
    );
    await manager.releaseStepLease(lease);
  }
  await client.exec(
    "UPDATE agent_runtime_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE status IN ('claimed', 'dispatched'); CHECKPOINT;",
  );
  // Deliberately bypass cleanup to exercise a fresh process and disk-backed database recovery.
  process.kill(process.pid, 'SIGKILL');
} else {
  const worker = new NativeAgentWorker(store, async (job, guard) => {
    guard.assertHeld();
    const lease = (await manager.acquireStepLease(job.operationId, job.stepIndex))!;
    await client.query('INSERT INTO native_test_effects(step) VALUES ($1)', [job.stepIndex]);
    await manager.saveStepResultWithLease(
      job.operationId,
      { stepIndex: job.stepIndex, executionTime: 1, newState: state(job.stepIndex + 1, 'done') },
      lease,
    );
    await manager.releaseStepLease(lease);
    return { success: true, nextStepScheduled: false, state: {} };
  });
  const host = new CordisProfileLoader({
    bundles: { base: { entries: [{ id: 'worker', use: 'worker' }] } },
    modules: {
      worker: {
        plugin: {
          apply(ctx) {
            ctx.provide('fixture.worker', worker);
            ctx.effect(() => worker.start(100_000));
          },
        },
      },
    },
    profile: { bundles: ['base'] },
  });
  await host.run(async () => worker.tick());
  await host.dispose();
  const jobs = await client.query(
    'SELECT step_index, status FROM agent_runtime_jobs ORDER BY step_index',
  );
  const effects = await client.query('SELECT step FROM native_test_effects ORDER BY id');
  console.info(
    'NATIVE_CRASH_REPORT ' +
      JSON.stringify({
        jobs: jobs.rows,
        effects: effects.rows.map((row: { step: number }) => row.step),
        status: (await manager.loadAgentState('op'))?.status,
      }),
  );
  await client.close();
}
