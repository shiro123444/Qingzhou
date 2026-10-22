// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHarnessRevision } from '@lobechat/agent-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatProbePort } from './chat-probe';
import type { ExperimentPort } from './contracts';
import { applyHarnessPatch, HarnessCoordinator } from './coordinator';
import { createImprovementHost } from './production';
import { FileHarnessStore } from './store';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope = { userId: 'owner', agentId: 'agent' };
const budget = {
  calls: 3,
  inputBytesPerCall: 32000,
  outputTokensPerCall: 512,
  deadlineMs: 5000,
  tokens: 120000,
  costMicros: 300000,
  costMicrosPerCall: 50000,
};
async function setup(schemaVersion: 1 | 2 = 1) {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-harness-'));
  roots.push(root);
  const coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  const base = await createHarnessRevision(
    scope,
    {
      agentConfig: { systemRole: 'original' },
      modelRuntimeConfig: { model: 'model', provider: 'provider' },
    },
    schemaVersion,
  );
  await coordinator.registerSource(base);
  const experiment = await coordinator.propose(scope, {
    baselineId: base.id,
    patch: { baseRevisionId: base.id, surface: 'chat.systemRole', value: 'candidate' },
    tasks: [{ id: 'train', prompt: 'training task' }],
    heldout: [
      { id: 'held-a', prompt: 'unseen A' },
      { id: 'held-b', prompt: 'unseen B' },
    ],
    budget,
    validationBudget: { ...budget, calls: 6, tokens: 240000 },
  });
  return { root, coordinator, base, experiment };
}
/** Deterministic fixture exercises protocol outcomes, not real-world model quality. */
function port(winner: 'original' | 'candidate' | 'unknown'): ExperimentPort {
  return {
    complete: async ({ system, prompt }) => {
      if (system.startsWith('Compare')) {
        if (winner === 'unknown') return { text: 'unavailable' };
        const data = JSON.parse(prompt);
        return {
          text: JSON.stringify({ choice: data.A === winner ? 'A' : 'B', reason: 'fixture choice' }),
        };
      }
      return { text: system, inputTokens: 10, outputTokens: 2 };
    },
  };
}
describe('native harness improvement loop', () => {
  it('validates a winner, requires exact user choice/CAS, preserves source and pins new runs', async () => {
    const { root, coordinator, base, experiment } = await setup();
    await expect(
      coordinator.decide(scope, {
        id: 'early',
        experimentId: experiment.id,
        candidateId: experiment.candidateId,
        action: 'adopt',
        reason: 'early',
      }),
    ).rejects.toThrow('HARNESS_NOT_VALIDATED');
    const trial = await coordinator.execute(scope, experiment.id, port('candidate'));
    expect(trial.status).toBe('completed');
    expect(trial.attempts).toHaveLength(3);
    expect(trial.comparisons[0].choice).toBe('candidate');
    const validation = await coordinator.execute(scope, experiment.id, port('candidate'), {
      validate: true,
    });
    expect(validation.validation).toBe('passed');
    expect(validation.attempts).toHaveLength(9);
    const choice = {
      id: 'choice',
      experimentId: experiment.id,
      candidateId: experiment.candidateId,
      action: 'adopt' as const,
      reason: 'Explicit choice',
    };
    await coordinator.decide(scope, choice);
    const restarted = new HarnessCoordinator(new FileHarnessStore(root));
    expect((await restarted.registerSource(base)).id).toBe(experiment.candidateId);
    expect((await restarted.registerSource(base, false)).id).toBe(experiment.candidateId);
    expect((await restarted.store.read(scope)).revisions[base.id].material.agentConfig).toEqual({
      systemRole: 'original',
    });
    expect(await restarted.decide(scope, choice)).toEqual(
      expect.objectContaining({ id: 'choice' }),
    );
    await expect(restarted.decide(scope, { ...choice, id: 'stale' })).rejects.toThrow(
      'HARNESS_CAS_CONFLICT',
    );
    await restarted.rollback(scope, {
      id: 'rollback',
      expectedActiveId: experiment.candidateId,
      reason: 'User rollback',
    });
    expect((await restarted.registerSource(base)).id).toBe(base.id);
    const episodes = (await restarted.store.read(scope)).episodes;
    expect(episodes).toHaveLength(3);
    expect(episodes.at(-1)?.selection).toMatchObject({
      action: 'adopt',
      subject: 'harness',
      selectedRevisionId: experiment.candidateId,
    });
  });
  it.each([1, 2] as const)(
    'retains schema %i baseline, treats failed judging as unknown, and never promotes either',
    async (schemaVersion) => {
      const { coordinator, experiment } = await setup(schemaVersion);
      const result = await coordinator.execute(scope, experiment.id, port('original'));
      expect(result.comparisons[0].choice).toBe('baseline');
      await coordinator.decide(scope, {
        id: 'keep',
        experimentId: experiment.id,
        candidateId: experiment.candidateId,
        action: 'keep',
        reason: 'Keep original',
      });
      expect((await coordinator.store.read(scope)).active).toBeUndefined();
      await coordinator.execute(scope, experiment.id, port('unknown'), { validate: true });
      expect((await coordinator.store.read(scope)).experiments[experiment.id].validation).toBe(
        'unknown',
      );
    },
  );
  it.each([1, 2] as const)(
    'preserves schema %i budget/cancellation boundaries, charges failures, and blocks duplicate execution',
    async (schemaVersion) => {
      const { coordinator, experiment } = await setup(schemaVersion);
      const calls = vi.fn(async () => {
        throw new Error('provider failed');
      });
      const result = await coordinator.execute(scope, experiment.id, { complete: calls });
      expect(result.status).toBe('failed');
      expect(result.attempts).toHaveLength(1);
      expect(calls).toHaveBeenCalledTimes(1);
      await expect(coordinator.execute(scope, experiment.id, port('candidate'))).rejects.toThrow(
        'HARNESS_EXPERIMENT_ALREADY_RUN',
      );
      const next = await setup(schemaVersion);
      await next.coordinator.store.cancel(scope, next.experiment.id);
      const cancelledCalls = vi.fn();
      const cancelled = await next.coordinator.execute(scope, next.experiment.id, {
        complete: cancelledCalls,
      });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelledCalls).not.toHaveBeenCalled();
      await expect(
        next.coordinator.propose(scope, {
          baselineId: next.base.id,
          patch: next.experiment.patch,
          tasks: next.experiment.tasks,
          heldout: next.experiment.heldout,
          budget: { ...budget, calls: 2 },
          validationBudget: budget,
        }),
      ).rejects.toThrow('HARNESS_INVALID_BUDGET');
    },
  );
  it('rejects cross-scope access, stale sources, polluted heldouts and arbitrary patches', async () => {
    const { coordinator, base, experiment } = await setup();
    await expect(
      applyHarnessPatch(base, { ...experiment.patch, surface: 'permissions' as any }),
    ).rejects.toThrow('HARNESS_INVALID_SURFACE');
    await expect(
      coordinator.execute({ ...scope, userId: 'other' }, experiment.id, port('candidate')),
    ).rejects.toThrow('HARNESS_EXPERIMENT_NOT_FOUND');
    await coordinator.execute(scope, experiment.id, port('candidate'));
    await coordinator.execute(scope, experiment.id, port('candidate'), { validate: true });
    await expect(
      coordinator.propose(scope, {
        baselineId: base.id,
        patch: experiment.patch,
        tasks: experiment.tasks,
        heldout: experiment.heldout,
        budget,
        validationBudget: { ...budget, calls: 6 },
      }),
    ).rejects.toThrow('HARNESS_CONTAMINATED_TASKS');
    const edit = await createHarnessRevision(scope, { agentConfig: { systemRole: 'User edit' } });
    await coordinator.registerSource(edit);
    await expect(
      coordinator.decide(scope, {
        id: 'outdated',
        experimentId: experiment.id,
        candidateId: experiment.candidateId,
        action: 'adopt',
        reason: 'stale',
      }),
    ).rejects.toThrow('HARNESS_STALE_SOURCE');
  });
  it('mounts the service in native Cordis, drains disposal and excludes overlapping writers', async () => {
    const { root, coordinator } = await setup();
    const host = createImprovementHost(root);
    const record = await host.run((ctx) => ctx.get('qingzhou.improvement')!.store.read(scope));
    expect(record.sourceRevisionId).toBeTruthy();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const running = coordinator.store.transaction(scope, async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await ready;
    await expect(coordinator.store.transaction(scope, async () => undefined)).rejects.toThrow(
      'HARNESS_BUSY',
    );
    release();
    await running;
    await host.dispose();
    await expect(host.run(async () => undefined)).rejects.toThrow();
  });
  it('rejects oversized state publication without overwriting existing evidence', async () => {
    const { coordinator, base } = await setup();
    await expect(
      coordinator.store.transaction(scope, async (state, save) => {
        state.intents = Array.from({ length: 129 }, (_, index) => ({
          id: String(index),
          domain: 'managed-skill',
          operation: 'create',
          material: {},
          status: 'pending-validation',
          at: '',
        }));
        await save();
      }),
    ).rejects.toThrow('HARNESS_QUOTA_EXCEEDED');
    const stored = await coordinator.store.read(scope);
    expect(stored.sourceRevisionId).toBe(base.id);
    expect(stored.intents).toBeUndefined();
  });
  it.each([1, 2] as const)(
    'holds schema %i reservations for a cancelled in-flight call and rejects late results',
    async (schemaVersion) => {
      const { coordinator, experiment } = await setup(schemaVersion);
      const controller = new AbortController();
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const complete = vi.fn(async () => {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        return { text: 'late answer', costMicros: 10 };
      });
      const running = coordinator.execute(
        scope,
        experiment.id,
        { complete },
        { signal: controller.signal },
      );
      await ready;
      controller.abort();
      const during = await coordinator.store.read(scope);
      expect(during.experiments[experiment.id].attempts[0]).toMatchObject({
        status: 'reserved',
        chargedCostMicros: budget.costMicrosPerCall,
      });
      release();
      const result = await running;
      expect(result.status).toBe('cancelled');
      expect(result.comparisons).toEqual([]);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(result.attempts[0].chargedCostMicros).toBe(budget.costMicrosPerCall);
    },
  );
  it.each([1, 2] as const)(
    'stops schema %i execution on excessive receipts without another call',
    async (schemaVersion) => {
      const { coordinator, experiment } = await setup(schemaVersion);
      const complete = vi.fn(async () => ({
        text: 'expensive answer',
        inputTokens: 1,
        outputTokens: 1,
        costMicros: budget.costMicros + 1,
      }));
      const result = await coordinator.execute(scope, experiment.id, { complete });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('HARNESS_BUDGET_EXCEEDED');
      expect(result.attempts[0].chargedCostMicros).toBe(budget.costMicros + 1);
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );
  it('uses real AgentRuntime/Cordis with a text-only provider and replaceable context strategy', async () => {
    const received: any[] = [];
    const chat = vi.fn(async (payload, options) => {
      received.push(payload);
      options.callback.onText('answer');
      options.callback.onCompletion({ usage: { totalInputTokens: 5, totalOutputTokens: 1 } });
      return new Response('');
    });
    const probe = createChatProbePort({
      model: 'pinned-model',
      provider: 'test',
      runtime: { chat },
      strategy: 'evidence-first',
    });
    const result = await probe.complete({
      system: 'original',
      prompt: 'question',
      maxTokens: 128,
      signal: new AbortController().signal,
    });
    expect(result.text).toBe('answer');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(received[0].tools).toEqual([]);
    expect(received[0].model).toBe('pinned-model');
    expect(received[0].messages[0].content).toContain('supplied evidence');
    const isolated = createChatProbePort({
      model: 'pinned-model',
      provider: 'test',
      runtime: { chat },
      material: {
        agentDocuments: [
          {
            content: 'PRIVATE_DOCUMENT',
            title: 'Private',
            id: 'doc',
            filename: 'AGENTS.md',
            policyLoad: 'always',
          },
        ],
      },
    });
    await isolated.complete({
      system: 'Compare answers',
      prompt: 'answers',
      maxTokens: 128,
      purpose: 'selection',
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(received.at(-1).messages)).not.toContain('PRIVATE_DOCUMENT');
    const tooLarge = createChatProbePort({
      model: 'pinned-model',
      provider: 'test',
      runtime: { chat },
    });
    const before = chat.mock.calls.length;
    await expect(
      tooLarge.complete({
        system: 'instruction',
        prompt: 'question',
        maxTokens: 128,
        maxInputBytes: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('HARNESS_PROBE_FAILED');
    expect(chat.mock.calls).toHaveLength(before);
  });
  it('compares a registered context plugin with the same budget, then adopts only that configuration', async () => {
    const { coordinator, base, experiment } = await setup();
    const next = await coordinator.propose(scope, {
      baselineId: base.id,
      patch: { baseRevisionId: base.id, surface: 'chat.contextStrategy', value: 'evidence-first' },
      tasks: experiment.tasks,
      heldout: experiment.heldout,
      budget,
      validationBudget: { ...budget, calls: 6, tokens: 240000 },
    });
    const models: string[] = [];
    const chat = vi.fn(async (payload, options) => {
      const prompt = JSON.stringify(payload.messages);
      const answer = prompt.includes('supplied evidence')
        ? 'evidence-based answer'
        : 'ordinary answer';
      models.push(payload.model);
      options.callback.onText(
        prompt.includes('Compare the two')
          ? JSON.stringify({
              choice:
                prompt.indexOf('evidence-based answer') < prompt.indexOf('ordinary answer')
                  ? 'A'
                  : 'B',
              reason: 'fixture',
            })
          : answer,
      );
      options.callback.onCompletion({ usage: { totalInputTokens: 5, totalOutputTokens: 4 } });
      return new Response('');
    });
    const probe = createChatProbePort({
      model: 'pinned-model',
      provider: 'test',
      runtime: { chat },
    });
    expect((await coordinator.execute(scope, next.id, probe)).comparisons[0].choice).toBe(
      'candidate',
    );
    expect((await coordinator.execute(scope, next.id, probe, { validate: true })).validation).toBe(
      'passed',
    );
    await coordinator.decide(scope, {
      id: 'strategy-choice',
      experimentId: next.id,
      candidateId: next.candidateId,
      action: 'adopt',
    });
    const active = await coordinator.registerSource(base);
    expect(active.material.contextPolicy).toMatchObject({ promptStrategy: 'evidence-first' });
    expect(active.material.agentConfig).toEqual(base.material.agentConfig);
    expect(models).toHaveLength(9);
    await expect(
      applyHarnessPatch(base, {
        baseRevisionId: base.id,
        surface: 'chat.contextStrategy',
        value: '/tmp/arbitrary-code',
      }),
    ).rejects.toThrow('HARNESS_UNKNOWN_STRATEGY');
  });
});
