import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
require.extensions['.md'] = (module, filename) => {
  module.exports = readFileSync(filename, 'utf8');
};
const schema =
  require('../packages/database/src/schemas') as typeof import('../packages/database/src/schemas');
const { DatabaseLearningBudget } =
  require('../src/server/runtime/improvement/budget-store') as typeof import('../src/server/runtime/improvement/budget-store');
const { createHarnessRevision } =
  require('../packages/agent-runtime/src') as typeof import('../packages/agent-runtime/src');
const { HarnessCoordinator } =
  require('../src/server/runtime/improvement/coordinator') as typeof import('../src/server/runtime/improvement/coordinator');
const { FileHarnessStore } =
  require('../src/server/runtime/improvement/store') as typeof import('../src/server/runtime/improvement/store');
const { preparePublication, validationDigest } =
  require('../src/server/runtime/improvement/publication') as typeof import('../src/server/runtime/improvement/publication');

const database = new URL(process.env.DATABASE_URL!);
assert(database.pathname.startsWith('/qingzhou_accept_'), 'ISOLATED_DATABASE_REQUIRED');
const directory = path.resolve('.data/acceptance/postgres');
await mkdir(directory, { recursive: true, mode: 0o700 });
const pool = new Pool({ connectionString: database.href, max: 3 });
const db = drizzle(pool, { schema });
const userId = `accept-${randomUUID()}`;
const scope = { userId, subject: { kind: 'agent' as const, agentId: 'concurrency-fixture' } };
const budget = new DatabaseLearningBudget(db as any);
const children: ReturnType<typeof fork>[] = [];
async function worker(job: unknown) {
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(job), { mode: 0o600 });
  const child = fork(
    fileURLToPath(new URL('./harnessAcceptanceWorker.mts', import.meta.url)),
    [file],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        FEATURE_FLAGS: '+agent_self_iteration',
        QINGZHOU_HARNESS_LEARNING_ENABLED: '1',
      },
    },
  );
  children.push(child);
  child.stderr?.pipe(createWriteStream(path.join(directory, `${child.pid}.log`), { mode: 0o600 }));
  const events: any[] = [];
  let dispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  const result = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('WORKER_TIMEOUT'));
    }, 60000);
    child.on('message', (event: any) => {
      events.push(event);
      if (event.type === 'dispatched') dispatch();
      if (event.type === 'result') {
        clearTimeout(timer);
        resolve(event);
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!events.some((e) => e.type === 'result')) resolve({ ok: false, signal, code });
    });
  });
  const dispatchOrExit = Promise.race([
    dispatched,
    result.then((event) => {
      if (!events.some((e) => e.type === 'dispatched'))
        throw new Error(
          `WORKER_STOPPED_BEFORE_DISPATCH:${event.error || event.code || event.signal}`,
        );
    }),
  ]);
  void dispatchOrExit.catch(() => undefined);
  return { child, result, events, dispatched: dispatchOrExit };
}
const checks: string[] = [];
try {
  await db.insert(schema.users).values({ id: userId });
  await budget.open(scope, 'allocation', { calls: 10, tokens: 100, costMicros: 100 });
  const competitors = await Promise.all(
    ['one', 'two'].map((childId) =>
      worker({
        action: 'allocate',
        ref: { scope, rootId: 'allocation', childId },
        limit: { calls: 6, tokens: 60, costMicros: 60 },
      }),
    ),
  );
  const allocation = await Promise.all(competitors.map((c) => c.result));
  assert.equal(allocation.filter((r) => r.ok).length, 1);
  assert.equal(new Set(allocation.map((r) => r.pid)).size, 2);
  checks.push('two-process allocation cannot overbook parent');
  const ref = { scope, rootId: 'crash', childId: 'probe' };
  await budget.open(scope, ref.rootId, { calls: 1, tokens: 10, costMicros: 10 });
  await budget.allocate(ref, { calls: 1, tokens: 10, costMicros: 10 });
  const crashed = await worker({ action: 'crash', ref });
  await crashed.dispatched;
  crashed.child.kill('SIGKILL');
  await crashed.result;
  const replacement = await worker({ action: 'complete', ref });
  assert.match((await replacement.result).error, /LEARNING_ATTEMPT_EXISTS/u);
  assert.equal(replacement.events.filter((e) => e.type === 'dispatched').length, 0);
  assert.equal(Object.values((await budget.read(scope, ref.rootId)).attempts)[0].state, 'reserved');
  checks.push('SIGKILL after dispatch retains reservation and forbids replay');
  const cancellation = { ...ref, rootId: 'cancel' };
  await budget.open(scope, cancellation.rootId, { calls: 1, tokens: 10, costMicros: 10 });
  await budget.allocate(cancellation, { calls: 1, tokens: 10, costMicros: 10 });
  const running = await worker({ action: 'wait-cancel', ref: cancellation });
  await running.dispatched;
  const cancel = await worker({ action: 'cancel', ref: cancellation });
  assert((await cancel.result).ok);
  assert.match((await running.result).error, /LEARNING_BUDGET_CANCELLED/u);
  assert(running.events.some((e) => e.type === 'aborted'));
  assert((await budget.read(scope, cancellation.rootId)).cancelled);
  checks.push('another process cancels active work and late values are rejected');
  const agentId = `accept-agent-${randomUUID()}`,
    publicationScope = { userId, agentId };
  await db.insert(schema.agents).values({
    id: agentId,
    userId,
    systemRole: 'original',
    chatConfig: { autoCreateTopicThreshold: 2, selfIteration: { enabled: true } },
  });
  const coordinator = new HarnessCoordinator(
    new FileHarnessStore(path.join(directory, 'experiments')),
  );
  const base = await createHarnessRevision(
    publicationScope,
    {
      agentConfig: { systemRole: 'original', generation: 0 },
      configurationComplete: true,
    },
    2,
  );
  await coordinator.registerSource(base);
  const phase = {
    calls: 3,
    tokens: 120000,
    costMicros: 300,
    costMicrosPerCall: 100,
    inputBytesPerCall: 32000,
    outputTokensPerCall: 128,
    deadlineMs: 15000,
  };
  const experiment = await coordinator.propose(publicationScope, {
    baselineId: base.id,
    patch: { baseRevisionId: base.id, surface: 'chat.systemRole', value: 'candidate' },
    tasks: [{ id: 'trial', prompt: 'Fixture task' }],
    heldout: [
      { id: 'a', prompt: 'Unseen fixture A' },
      { id: 'b', prompt: 'Unseen fixture B' },
    ],
    budget: phase,
    validationBudget: { ...phase, calls: 6, tokens: 240000, costMicros: 600 },
  });
  const complete = async ({ system, prompt }: { system: string; prompt: string }) => ({
    text: system.startsWith('Compare')
      ? JSON.stringify({
          choice: JSON.parse(prompt).A === 'candidate' ? 'A' : 'B',
          reason: 'Transaction fixture',
        })
      : system,
  });
  await coordinator.execute(publicationScope, experiment.id, { complete });
  const validated = await coordinator.execute(
    publicationScope,
    experiment.id,
    { complete },
    { validate: true },
  );
  const command = {
    action: 'adopt' as const,
    id: randomUUID(),
    experimentId: experiment.id,
    candidateId: experiment.candidateId,
    expectedGeneration: 0,
    expectedSourceGeneration: 0,
    expectedSourceId: base.id,
    validationDigest: await validationDigest(validated),
  };
  const proof = await preparePublication(coordinator.store, publicationScope, command);
  const publishers = await Promise.all(
    [command, { ...command, id: randomUUID() }].map((item) =>
      worker({ action: 'commit', scope: publicationScope, command: item, proof }),
    ),
  );
  const publicationResults = await Promise.all(publishers.map((p) => p.result));
  assert.equal(
    publicationResults.filter((r) => r.ok).length,
    1,
    JSON.stringify(publicationResults),
  );
  assert.equal(
    (
      await db
        .select()
        .from(schema.agentHarnessDecisions)
        .where(eq(schema.agentHarnessDecisions.userId, userId))
    ).length,
    1,
  );
  checks.push('two-process adoption commits exactly one decision and generation');
  const cancellationWorker = await worker({
    action: 'publication-cancel',
    scope: publicationScope,
    proof,
  });
  assert((await cancellationWorker.result).ok);
  const cancelledCommit = await worker({
    action: 'commit',
    scope: publicationScope,
    command: { ...command, id: randomUUID() },
    proof,
  });
  assert.match((await cancelledCommit.result).error, /HARNESS_CANCELLED/u);
  checks.push('durable publication cancellation rejects a prepared proof in another process');
  // Recovery is independent of the request that committed the decision.
  const deliveryCrash = await worker({ action: 'maintenance', crashDelivery: true });
  await deliveryCrash.dispatched;
  deliveryCrash.child.kill('SIGKILL');
  await deliveryCrash.result;
  await db
    .update(schema.agentHarnessDecisions)
    .set({ leaseUntil: new Date(0) })
    .where(eq(schema.agentHarnessDecisions.userId, userId));
  const recoveries = await Promise.all([
    worker({ action: 'maintenance' }),
    worker({ action: 'maintenance' }),
  ]);
  assert((await Promise.all(recoveries.map((w) => w.result))).every((r) => r.ok));
  assert.equal(
    recoveries
      .flatMap((w) => w.events)
      .filter((e) => e.type === 'delivery' && e.event.scope.userId === userId).length,
    1,
  );
  assert(
    (
      await db
        .select()
        .from(schema.agentHarnessDecisions)
        .where(eq(schema.agentHarnessDecisions.userId, userId))
    )[0].deliveredAt,
  );
  checks.push('expired outbox lease is recovered by exactly one of two restarted workers');
  const { LearningMaintenance } = require('../src/server/runtime/learning-lifecycle/maintenance');
  const { ownedLearningDirectory } = require('../src/server/runtime/learning-lifecycle/files');
  const { harnessDigest } = require('../packages/agent-runtime/src');
  const {
    DatabaseHarnessPublication,
  } = require('../src/server/runtime/improvement/publication-store');
  const eraseUser = `erase-${randomUUID()}`,
    eraseKey = await harnessDigest({ userId: eraseUser, agentId: 'erase-fixture' });
  await db.insert(schema.users).values({ id: eraseUser });
  const ownedPath = ownedLearningDirectory(
    eraseUser,
    process.env.QINGZHOU_HARNESS_DATA_ROOT!,
    eraseKey,
  );
  await mkdir(ownedPath, { recursive: true, mode: 0o700 });
  await writeFile(path.join(ownedPath, 'private.json'), 'private fixture', { mode: 0o600 });
  const holder = await worker({ action: 'hold-account', userId: eraseUser, key: eraseKey });
  await holder.dispatched;
  const maintenance = new LearningMaintenance(
    db as any,
    new DatabaseHarnessPublication(db as any),
    async () => {},
  );
  await maintenance.requestErasure(eraseUser);
  const lateAdmission = await worker({
    action: 'open',
    scope: { userId: eraseUser, subject: { kind: 'agent', agentId: 'erase-fixture' } },
    rootId: 'late-root',
    limit: { calls: 1, tokens: 10, costMicros: 10 },
  });
  assert.match((await lateAdmission.result).error, /LEARNING_ACCOUNT_DELETING/u);
  checks.push('account tombstone rejects new root admission in another process');
  // A request alone cannot erase a still-present account.
  await maintenance.tick();
  await access(ownedPath);
  await db.delete(schema.users).where(eq(schema.users.id, eraseUser));
  const waitingErasure = await worker({ action: 'maintenance' });
  assert((await waitingErasure.result).ok);
  await access(ownedPath);
  holder.child.kill('SIGKILL');
  await holder.result;
  const recoveredErasure = await worker({ action: 'maintenance' });
  assert((await recoveredErasure.result).ok);
  assert((await lstat(ownedPath)).isFile());
  await assert.rejects(mkdir(path.join(ownedPath, 'late'), { recursive: true }));
  checks.push(
    'erasure survives restart, waits for a separate process and retains a live account until DB deletion',
  );
  const report = { schemaVersion: 1, database: 'isolated-postgresql', checks, paidModelCalls: 0 };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await pool.end();
}
