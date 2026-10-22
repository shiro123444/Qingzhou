import { executeBudgetedSignal } from './signal-budget';
import * as production from './production';
// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { createHarnessRevision, type LearningScope } from '@lobechat/agent-runtime';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestLearningErasure } from '../learning-lifecycle/files';
import { learningBudgetRoots, users } from '@/database/schemas';
import { UserModel } from '@/database/models/user';
import { createToolSet } from '@/server/services/agentSignal/services/selfIteration/tools/shared';

import { DatabaseLearningBudget } from './budget-store';
import { LearningBudgetBinding } from './budget';
import { openLearningBudget } from './production';
import { HarnessCoordinator } from './coordinator';
import { FileHarnessStore } from './store';
import { LearningCommands } from './learning-commands';

const db = await getTestDB();
const scope: LearningScope = {
  userId: 'budget-owner',
  subject: { kind: 'agent', agentId: 'budget-agent' },
};
const limit = { calls: 10, tokens: 200000, costMicros: 1000 };
let directory: string;
beforeEach(async () => {
  await db.insert(users).values({ id: scope.userId });
  directory = await mkdtemp(path.join(tmpdir(), 'learning-budget-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.delete(users).where(eq(users.id, scope.userId));
  await rm(directory, { recursive: true, force: true });
});
const store = () => new DatabaseLearningBudget(db);
async function binding() {
  return (await openLearningBudget(store(), scope, 'cycle', limit, { reflection: limit }))
    .reflection;
}
describe('durable common learning budgets and domain commands', () => {
  it('fences new budgets and dispatch admission after an erasure request while allowing an existing receipt to settle', async () => {
    vi.stubEnv('QINGZHOU_LEARNING_LIFECYCLE_ROOT', path.join(directory, 'lifecycle'));
    const port = store();
    await port.open(scope, 'deleting-cycle', limit);
    const ref = { scope, rootId: 'deleting-cycle', childId: 'reflection' };
    await port.allocate(ref, limit);
    await port.reserve(ref, 'prior-dispatch', 'request-hash', {
      calls: 1,
      tokens: 10,
      costMicros: 1,
    });
    requestLearningErasure(scope.userId);
    await expect(port.open(scope, 'late-cycle', limit)).rejects.toThrow(
      'LEARNING_ACCOUNT_DELETING',
    );
    await expect(async () => port.allocate({ ...ref, childId: 'late' }, limit)).rejects.toThrow(
      'LEARNING_ACCOUNT_DELETING',
    );
    await expect(async () =>
      port.reserve(ref, 'late', 'late-hash', { calls: 1, tokens: 10, costMicros: 1 }),
    ).rejects.toThrow('LEARNING_ACCOUNT_DELETING');
    await expect(port.read(scope, ref.rootId)).rejects.toThrow('LEARNING_ACCOUNT_DELETING');
    await port.settle(ref, 'prior-dispatch', 'unknown');
    const [row] = await db
      .select()
      .from(learningBudgetRoots)
      .where(eq(learningBudgetRoots.userId, scope.userId));
    expect(Object.values((row.state as any).attempts)[0]).toMatchObject({
      state: 'unknown',
      reserved: { calls: 1, tokens: 10, costMicros: 1 },
    });
  });

  it('cascades account deletion through durable receipts while retaining another account budget', async () => {
    const owner = await binding();
    await owner.perform(
      {
        id: 'completed-before-deletion',
        request: {},
        reserved: { calls: 1, tokens: 10, costMicros: 1 },
      },
      async () => true,
    );
    const other = { ...scope, userId: 'budget-other-owner' };
    await db.insert(users).values({ id: other.userId });
    try {
      await store().open(other, 'cycle', limit);
      await UserModel.deleteUser(db, scope.userId);
      await expect(store().read(scope, 'cycle')).rejects.toThrow('LEARNING_BUDGET_NOT_FOUND');
      expect((await store().read(other, 'cycle')).scope.userId).toBe(other.userId);
    } finally {
      await UserModel.deleteUser(db, other.userId);
    }
  });
  it('does not dispatch if durable admission fails, and rolls back the reservation', async () => {
    const b = await binding(),
      run = vi.fn(async () => true);
    await db.execute(
      sql.raw(
        "CREATE FUNCTION fail_learning_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test admission failure'; END; $$ LANGUAGE plpgsql;",
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER fail_learning_update BEFORE UPDATE ON learning_budget_roots FOR EACH ROW EXECUTE FUNCTION fail_learning_update();',
      ),
    );
    try {
      await expect(
        b.perform(
          { id: 'must-not-send', request: {}, reserved: { calls: 1, tokens: 10, costMicros: 1 } },
          run,
        ),
      ).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
      expect(Object.keys((await store().read(scope, 'cycle')).attempts)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER fail_learning_update ON learning_budget_roots;'));
      await db.execute(sql.raw('DROP FUNCTION fail_learning_update();'));
    }
  });
  it('serializes competing child allocations instead of overbooking the parent', async () => {
    const port = store();
    await port.open(scope, 'cycle', limit);
    const results = await Promise.allSettled(
      ['a', 'b'].map((childId) =>
        store().allocate(
          { scope, rootId: 'cycle', childId },
          { calls: 6, tokens: 120000, costMicros: 600 },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(Object.keys((await port.read(scope, 'cycle')).children)).toHaveLength(1);
  });
  it('reserves before dispatch and keeps unknown calls charged across service instances and exact replays', async () => {
    const b = await binding();
    const run = vi.fn(async () => {
      throw new Error('Disconnected after dispatch');
    });
    const input = {
      id: 'call:0',
      request: { model: 'model' },
      reserved: { calls: 1, tokens: 1000, costMicros: 100 },
    };
    await expect(b.perform(input, run)).rejects.toThrow('Disconnected');
    const replacement = new LearningBudgetBinding(store(), b.ref);
    await expect(replacement.perform(input, run)).rejects.toThrow('LEARNING_ATTEMPT_EXISTS');
    const state = await store().read(scope, 'cycle');
    expect(Object.values(state.attempts)[0]).toMatchObject({
      state: 'unknown',
      reserved: input.reserved,
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(
      replacement.perform({ ...input, request: { model: 'changed' } }, run),
    ).rejects.toThrow('LEARNING_BUDGET_CONFLICT');
  });
  it('retains reservations when usage is lower, records measured usage separately, and blocks overruns', async () => {
    const b = await binding();
    await b.perform(
      {
        id: 'known',
        request: {},
        reserved: { calls: 1, tokens: 1000, costMicros: 100 },
        measure: () => ({ tokens: 10 }),
      },
      async () => true,
    );
    expect(Object.values((await store().read(scope, 'cycle')).attempts)[0]).toMatchObject({
      reserved: { tokens: 1000, costMicros: 100 },
      measured: { tokens: 10 },
    });
    await expect(
      b.perform(
        {
          id: 'overrun',
          request: {},
          reserved: { calls: 1, tokens: 1000, costMicros: 100 },
          measure: () => ({ tokens: 1001 }),
        },
        async () => true,
      ),
    ).rejects.toThrow('LEARNING_BUDGET_EXCEEDED');
    await expect(
      b.perform(
        { id: 'next', request: {}, reserved: { calls: 1, tokens: 1, costMicros: 1 } },
        async () => true,
      ),
    ).rejects.toThrow('LEARNING_BUDGET_EXCEEDED');
  });
  it('persists cancellation before abort, rejects late results and prevents spending another phase', async () => {
    const b = await binding();
    let entered!: () => void, release!: () => void, signal!: AbortSignal;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      drain = new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = b.perform(
      { id: 'pending', request: {}, reserved: { calls: 1, tokens: 1000, costMicros: 100 } },
      async (s) => {
        signal = s;
        entered();
        await drain;
        return true;
      },
    );
    await ready;
    await store().cancel(scope, 'cycle');
    try {
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect((await store().read(scope, 'cycle')).cancelled).toBe(true);
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow('LEARNING_BUDGET_CANCELLED');
    await expect(
      store().allocate(
        { scope, rootId: 'cycle', childId: 'validation' },
        { calls: 0, tokens: 0, costMicros: 0 },
      ),
    ).rejects.toThrow('LEARNING_BUDGET_CANCELLED');
    expect(Object.values((await store().read(scope, 'cycle')).attempts)[0].reserved.tokens).toBe(
      1000,
    );
  });
  it('does not conflate tenants, subjects, command types or configuration identities', async () => {
    await binding();
    await expect(store().read({ ...scope, userId: 'stranger' }, 'cycle')).rejects.toThrow(
      'LEARNING_BUDGET_NOT_FOUND',
    );
    const ppt: LearningScope = {
      userId: scope.userId,
      subject: { kind: 'presentation', jobId: 'real-job', sessionId: 'session' },
    };
    await expect(store().read(ppt, 'cycle')).rejects.toThrow('LEARNING_BUDGET_SCOPE');
    const commands = new LearningCommands();
    await expect(
      commands.capture({
        type: 'behavior-activation',
        scope: ppt,
        id: 'choice',
        domain: 'presentation',
        evidenceRef: 'archive',
        configurations: [{}],
        outcome: 'candidate',
        applicability: 'source-page-only',
        selection: { action: 'adopt', requestId: 'choice', selectedIndex: 0 },
      }),
    ).rejects.toThrow('LEARNING_COMMAND_INVALID');
    const artifact = await commands.capture({
      type: 'artifact-fork',
      scope: ppt,
      id: 'choice',
      domain: 'presentation',
      evidenceRef: 'archive',
      configurations: [{ complete: 'original' }, { complete: 'candidate' }],
      outcome: 'candidate',
      applicability: 'source-page-only',
      selection: { action: 'adopt', requestId: 'choice', selectedIndex: 1 },
    });
    expect(artifact.episode).toMatchObject({
      schemaVersion: 2,
      scope: ppt,
      validation: 'pending',
      selection: { type: 'artifact-fork' },
    });
    expect(JSON.stringify(artifact)).not.toContain('agentId');
    expect(artifact.configurations.map((c) => c.id)).toEqual(artifact.episode.configurationRefs);
  });
  it('charges an actual AgentSignal reflection plus probe and independent validation to one parent without extra model calls', async () => {
    const port = store();
    const reflection = { calls: 1, tokens: 132608, costMicros: 50000 };
    const probe = { calls: 3, tokens: 15000, costMicros: 300 },
      validation = { calls: 6, tokens: 30000, costMicros: 600 };
    const b = await openLearningBudget(
      port,
      scope,
      'combined',
      { calls: 10, tokens: 177608, costMicros: 50900 },
      { reflection, probe, validation },
    );
    const chat = vi.fn(async (_payload: any, options: any) => {
      options.callback.onText('A reflection observation');
      return new Response('');
    });
    const c = new HarnessCoordinator(new FileHarnessStore(directory));
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
    vi.spyOn(production, 'withHarnessCoordinator').mockImplementation((run) => run(c));
    const result = await executeBudgetedSignal(db, {
      agentId: 'budget-agent',
      userId: scope.userId,
      context: { agentId: 'budget-agent', userId: scope.userId },
      maxSteps: 2,
      model: 'model',
      modelRuntime: { chat },
      sourceId: 'signal-source',
      tools: createToolSet({
        reserveOperation: async () => ({ reserved: true as const }),
        writeReceipt: async () => ({ receiptId: 'receipt' }),
      }),
      learningBudget: b.reflection,
    });
    expect(result.learningRequests).toHaveLength(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(
      (await c.store.read({ userId: scope.userId, agentId: 'budget-agent' })).learning?.[0].episode,
    ).toMatchObject({
      scope,
      validation: 'pending',
      outcome: 'unknown',
      budgetRef: { rootId: 'combined' },
    });
    const agentScope = { userId: scope.userId, agentId: 'budget-agent' };
    const source = await createHarnessRevision(agentScope, {
      agentConfig: { systemRole: 'original' },
      configurationComplete: true,
    });
    await c.registerSource(source);
    const phase = {
      calls: 3,
      tokens: 15000,
      costMicros: 300,
      costMicrosPerCall: 100,
      inputBytesPerCall: 1024,
      outputTokensPerCall: 128,
      deadlineMs: 5000,
    };
    const experiment = await c.propose(agentScope, {
      baselineId: source.id,
      patch: { baseRevisionId: source.id, surface: 'chat.systemRole', value: 'candidate' },
      tasks: [{ id: 'probe', prompt: 'Representative' }],
      heldout: [
        { id: 'a', prompt: 'Unseen A' },
        { id: 'b', prompt: 'Unseen B' },
      ],
      budget: phase,
      validationBudget: { ...phase, ...validation },
    });
    const complete = vi.fn(async ({ system, prompt }: { system: string; prompt: string }) => ({
      text: system.startsWith('Compare')
        ? JSON.stringify({
            choice: JSON.parse(prompt).A === 'candidate' ? 'A' : 'B',
            reason: 'fixture',
          })
        : system,
    }));
    await c.execute(agentScope, experiment.id, { complete }, { learningBudget: b.probe });
    const validated = await c.execute(
      agentScope,
      experiment.id,
      { complete },
      { validate: true, learningBudget: b.validation },
    );
    expect(validated.validation).toBe('passed');
    expect(complete).toHaveBeenCalledTimes(9);
    const state = await port.read(scope, 'combined');
    expect(Object.keys(state.attempts)).toHaveLength(10);
    expect(Object.values(state.attempts).reduce((sum, a) => sum + a.reserved.costMicros, 0)).toBe(
      50900,
    );
    await expect(
      b.validation.perform(
        { id: 'extra', request: {}, reserved: { calls: 1, tokens: 1, costMicros: 1 } },
        async () => true,
      ),
    ).rejects.toThrow('LEARNING_BUDGET_EXCEEDED');
  });
});
