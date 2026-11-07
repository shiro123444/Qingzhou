import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require.extensions['.md'] = (module, filename) => {
  module.exports = readFileSync(filename, 'utf8');
};
const schema =
  require('../packages/database/src/schemas') as typeof import('../packages/database/src/schemas');
const { LearningBudgetBinding } =
  require('../src/server/runtime/improvement/budget') as typeof import('../src/server/runtime/improvement/budget');
const { DatabaseLearningBudget } =
  require('../src/server/runtime/improvement/budget-store') as typeof import('../src/server/runtime/improvement/budget-store');
const { userMutationAuthority } =
  require('../src/server/runtime/improvement/mutation-authority') as typeof import('../src/server/runtime/improvement/mutation-authority');
const { DatabaseHarnessPublication } =
  require('../src/server/runtime/improvement/publication-store') as typeof import('../src/server/runtime/improvement/publication-store');

const database = new URL(process.env.DATABASE_URL!);
if (!database.pathname.startsWith('/qingzhou_accept_'))
  throw new Error('ISOLATED_DATABASE_REQUIRED');
const pool = new Pool({ connectionString: database.href, max: 2 });
const db = drizzle(pool, { schema });
const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
const send = (value: unknown) => process.send?.(value);
try {
  const budget = new DatabaseLearningBudget(db as any);
  if (job.action === 'maintenance') {
    const { LearningMaintenance } = require('../src/server/runtime/learning-lifecycle/maintenance');
    const publication = new DatabaseHarnessPublication(db as any);
    const maintenance = new LearningMaintenance(db as any, publication, async (event: unknown) => {
      send({ type: 'delivery', event });
      if (job.crashDelivery) {
        send({ type: 'dispatched' });
        await new Promise(() => {});
      }
    });
    await maintenance.tick();
  } else if (job.action === 'hold-account') {
    const {
      ownedLearningDirectory,
      acquireAccountDataLease,
    } = require('../src/server/runtime/learning-lifecycle/files');
    const directory = ownedLearningDirectory(
      job.userId,
      process.env.QINGZHOU_HARNESS_DATA_ROOT!,
      job.key,
    );
    await acquireAccountDataLease(directory);
    send({ type: 'dispatched' });
    await new Promise(() => {});
  } else if (job.action === 'open') await budget.open(job.scope, job.rootId, job.limit);
  else if (job.action === 'allocate') await budget.allocate(job.ref, job.limit);
  else if (job.action === 'cancel') await budget.cancel(job.ref.scope, job.ref.rootId);
  else if (job.action === 'commit') {
    const publication = new DatabaseHarnessPublication(db as any, async () => job.proof.baseline);
    await publication.commit(
      job.scope,
      job.command,
      userMutationAuthority(job.scope.userId),
      job.proof,
    );
  } else if (job.action === 'publication-cancel') {
    const publication = new DatabaseHarnessPublication(db as any, async () => job.proof.baseline);
    await publication.cancel(
      job.scope,
      job.proof.experiment.id,
      userMutationAuthority(job.scope.userId),
    );
  } else {
    const binding = new LearningBudgetBinding(budget, job.ref);
    await binding.perform(
      {
        id: 'stable-attempt',
        request: { fixture: 'external-dispatch' },
        reserved: { calls: 1, tokens: 10, costMicros: 10 },
      },
      async (signal) => {
        send({ type: 'dispatched', pid: process.pid });
        if (job.action === 'crash') await new Promise(() => {});
        if (job.action === 'wait-cancel') {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          send({ type: 'aborted' });
        }
        return 'late-result';
      },
    );
  }
  send({ type: 'result', ok: true, pid: process.pid });
} catch (error) {
  send({
    type: 'result',
    ok: false,
    error: error instanceof Error ? error.message : 'FAILED',
    pid: process.pid,
  });
} finally {
  await pool.end();
  process.disconnect?.();
}
