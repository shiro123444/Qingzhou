// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getTestDB } from '@lobechat/database/test-utils';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDocumentModel } from '@/database/models/agentDocuments';
import { AgentSkillModel } from '@/database/models/agentSkill';
import {
  agents,
  agentHarnessDecisions,
  agentHarnessHeads,
  documents,
  users,
} from '@/database/schemas';
import * as featureGate from '@/server/services/agentSignal/featureGate';

import { HarnessCoordinator } from './coordinator';
import {
  learningMutationAuthority,
  userMutationAuthority,
  type MutationAuthority,
} from './mutation-authority';
import { createImprovementHost } from './production';
import { preparePublication, type PublicationCommand } from './publication';
import { DatabaseHarnessPublication } from './publication-store';
import { readCurrentHarnessSource } from './source';
import { FileHarnessStore } from './store';

const db = await getTestDB();
const scope = { userId: 'publication-owner', agentId: 'publication-agent' };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qingzhou-publication-'));
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
  vi.spyOn(featureGate, 'isAgentSignalEnabledForUser').mockResolvedValue(true);
  await db.insert(users).values({ id: scope.userId });
  await db.insert(agents).values({
    ...scope,
    id: scope.agentId,
    systemRole: 'Original',
    model: 'model',
    provider: 'provider',
    chatConfig: { autoCreateTopicThreshold: 2, selfIteration: { enabled: true } },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.delete(users).where(eq(users.id, scope.userId));
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
  const coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  await coordinator.registerSource(source);
  const budget = {
    calls: 3,
    inputBytesPerCall: 1024,
    outputTokensPerCall: 128,
    tokens: 15000,
    deadlineMs: 5000,
    costMicros: 300,
    costMicrosPerCall: 100,
  };
  const experiment = await coordinator.propose(scope, {
    baselineId: source.id,
    patch: { baseRevisionId: source.id, surface: 'chat.systemRole', value: 'Candidate' },
    tasks: [{ id: 'trial', prompt: 'Representative task' }],
    heldout: [
      { id: 'a', prompt: 'Unseen task A' },
      { id: 'b', prompt: 'Unseen task B' },
    ],
    budget,
    validationBudget: { ...budget, calls: 6, tokens: 30000, costMicros: 600 },
  });
  const complete = vi.fn(async ({ system, prompt }: { system: string; prompt: string }) => ({
    text: system.startsWith('Compare')
      ? JSON.stringify({
          choice: JSON.parse(prompt).A === 'Candidate' ? 'A' : 'B',
          reason: 'Deterministic protocol fixture',
        })
      : system,
  }));
  await coordinator.execute(scope, experiment.id, { complete });
  await coordinator.execute(scope, experiment.id, { complete }, { validate: true });
  const state = await coordinator.store.read(scope);
  const { validationDigest } = await import('./publication');
  const command: PublicationCommand = {
    id: 'explicit-confirmation',
    action: 'adopt',
    experimentId: experiment.id,
    candidateId: experiment.candidateId,
    expectedSourceId: source.id,
    expectedSourceGeneration: (source.material.agentConfig as { generation: number }).generation,
    expectedGeneration: 0,
    validationDigest: await validationDigest(state.experiments[experiment.id]),
  };
  const proof = await preparePublication(coordinator.store, scope, command);
  return {
    source,
    coordinator,
    complete,
    command,
    proof,
    publication: new DatabaseHarnessPublication(db),
    authority: userMutationAuthority(scope.userId),
  };
}

describe('transactional harness publication with actual PostgreSQL semantics', () => {
  it('commits pointer, decision, complete proof and outbox together; ordinary reads ignore the experiment lease', async () => {
    const f = await fixture();
    const result = await f.publication.commit(scope, f.command, f.authority, f.proof);
    expect(result).toMatchObject({
      action: 'adopt',
      generation: 1,
      revisionId: f.command.candidateId,
    });
    const [saved] = await db.select().from(agentHarnessDecisions);
    expect(saved.proof).toMatchObject({
      baseline: { id: f.source.id },
      candidate: { id: f.command.candidateId },
      validationDigest: f.command.validationDigest,
    });
    expect(saved.event).toMatchObject({ generation: 1, id: f.command.id });
    expect(saved.decision).toMatchObject({
      episode: {
        configurationRefs: [f.source.id, f.command.candidateId],
        selection: { requestId: f.command.id, selectedRevisionId: f.command.candidateId },
      },
    });
    expect(await f.publication.selection(f.source)).toMatchObject({
      publicationRef: { generation: 1, decisionId: f.command.id },
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lease = f.coordinator.store.transaction(scope, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      expect((await f.publication.resolve(f.source)).id).toBe(f.command.candidateId);
    } finally {
      release();
      await lease;
    }
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it('allows only one of two concurrent confirmations with the same expected generation', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.publication.commit(scope, f.command, f.authority, f.proof),
      new DatabaseHarnessPublication(db).commit(
        scope,
        { ...f.command, id: 'competing-confirmation' },
        f.authority,
        f.proof,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
        .message,
    ).toBe('HARNESS_CAS_CONFLICT');
    expect(await db.select().from(agentHarnessDecisions)).toHaveLength(1);
    expect((await f.publication.read(scope)).generation).toBe(1);
  });

  it('replays the exact request after edits or loss of the original files, but rejects reuse with another command', async () => {
    const f = await fixture();
    const saved = await f.publication.commit(scope, f.command, f.authority, f.proof);
    await db
      .update(agents)
      .set({ systemRole: 'User edit after successful confirmation' })
      .where(eq(agents.id, scope.agentId));
    await rm(root, { recursive: true, force: true });
    expect(await f.publication.commit(scope, f.command, f.authority)).toEqual(saved);
    expect(await f.publication.replay(scope, f.command, f.authority)).toEqual(saved);
    await expect(
      f.publication.commit(scope, { ...f.command, reason: 'Different command' }, f.authority),
    ).rejects.toThrow('HARNESS_DECISION_CONFLICT');
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it('rolls back the head update if inserting the decision/outbox fails', async () => {
    const f = await fixture();
    await db.execute(
      sql.raw(
        `CREATE FUNCTION fail_harness_decision() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test insert failure'; END; $$ LANGUAGE plpgsql;`,
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER fail_harness_decision BEFORE INSERT ON agent_harness_decisions FOR EACH ROW EXECUTE FUNCTION fail_harness_decision();',
      ),
    );
    try {
      await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow();
      expect(await db.select().from(agentHarnessHeads)).toHaveLength(0);
      expect(await db.select().from(agentHarnessDecisions)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER fail_harness_decision ON agent_harness_decisions;'));
      await db.execute(sql.raw('DROP FUNCTION fail_harness_decision();'));
    }
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it.each(['systemRole', 'model', 'provider', 'params'] as const)(
    'rejects a concurrent author %s edit without overwriting it',
    async (key) => {
      const f = await fixture();
      const value = key === 'params' ? { temperature: 0.7 } : 'Manual change';
      await db
        .update(agents)
        .set({ [key]: value })
        .where(eq(agents.id, scope.agentId));
      await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
        'HARNESS_STALE_SOURCE',
      );
      const [agent] = await db.select().from(agents).where(eq(agents.id, scope.agentId));
      expect(agent[key]).toEqual(value);
      expect((await f.publication.read(scope)).generation).toBe(0);
    },
  );

  it('detects ABA author edits even when the original body and timestamp are restored', async () => {
    const f = await fixture();
    const [original] = await db.select().from(agents).where(eq(agents.id, scope.agentId));
    await db
      .update(agents)
      .set({ systemRole: 'Intermediate edit' })
      .where(eq(agents.id, scope.agentId));
    await db
      .update(agents)
      .set({ systemRole: original.systemRole, generation: 0, updatedAt: original.updatedAt })
      .where(eq(agents.id, scope.agentId));
    const [current] = await db.select().from(agents).where(eq(agents.id, scope.agentId));
    expect(current.generation).toBe(2);
    await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
      'HARNESS_STALE_SOURCE',
    );
  });

  it('does not redefine source identity when only housekeeping timestamps are touched', async () => {
    const f = await fixture();
    await db
      .update(agents)
      .set({ accessedAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, scope.agentId));
    const current = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
    expect(current.id).toBe(f.source.id);
    await expect(
      f.publication.commit(scope, f.command, f.authority, f.proof),
    ).resolves.toMatchObject({ generation: 1 });
  });

  it('rejects changed document material even if the author instruction did not change', async () => {
    const doc = await new AgentDocumentModel(db, scope.userId).create(
      scope.agentId,
      'AGENTS.md',
      'Original document',
    );
    const f = await fixture();
    await db
      .update(documents)
      .set({ content: 'Concurrent document edit' })
      .where(eq(documents.id, doc.documentId));
    await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
      'HARNESS_STALE_SOURCE',
    );
  });

  it('detects ABA skill body edits through immutable source generation references', async () => {
    const model = new AgentSkillModel(db, scope.userId);
    const skill = await model.create({
      name: 'test-skill',
      identifier: 'test-skill',
      description: 'A skill',
      source: 'user',
      content: 'Original skill',
    });
    const f = await fixture();
    await model.update(skill.id, { content: 'Changed skill' });
    await model.update(skill.id, { content: 'Original skill' });
    await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
      'HARNESS_STALE_SOURCE',
    );
  });

  it('binds confirmation to the viewed validation manifest', async () => {
    const f = await fixture();
    await expect(
      f.publication.commit(
        scope,
        { ...f.command, validationDigest: 'a different view' },
        f.authority,
        f.proof,
      ),
    ).rejects.toThrow('HARNESS_STALE_VALIDATION');
    expect(await db.select().from(agentHarnessHeads)).toHaveLength(0);
    await f.coordinator.store.cancel(scope, f.proof.experiment.id);
    await expect(preparePublication(f.coordinator.store, scope, f.command)).rejects.toThrow(
      'HARNESS_CANCELLED',
    );
  });

  it('rejects an already prepared publication after durable cancellation', async () => {
    const f = await fixture();
    await f.publication.cancel(scope, f.proof.experiment.id, f.authority);
    await f.publication.cancel(scope, f.proof.experiment.id, f.authority);
    expect(await f.coordinator.store.cancelled(scope, f.proof.experiment.id)).toBe(false);
    await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
      'HARNESS_CANCELLED',
    );
    expect(await f.publication.read(scope)).toMatchObject({
      generation: 0,
      cancelledExperiments: [f.proof.experiment.id],
    });
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it('does not revoke a decision committed before cancellation; replay remains a read', async () => {
    const f = await fixture();
    const saved = await f.publication.commit(scope, f.command, f.authority, f.proof);
    await f.publication.cancel(scope, f.proof.experiment.id, f.authority);
    expect(await f.publication.commit(scope, f.command, f.authority)).toEqual(saved);
    await expect(
      f.publication.commit(
        scope,
        {
          ...f.command,
          id: 'new-choice',
          expectedGeneration: 1,
          expectedActiveId: f.command.candidateId,
        },
        f.authority,
        f.proof,
      ),
    ).rejects.toThrow('HARNESS_CANCELLED');
    expect((await f.publication.read(scope)).active?.id).toBe(f.command.candidateId);
  });

  it('requires a host-issued user authority; a learning or serialized authority cannot publish', async () => {
    const f = await fixture();
    for (const authority of [
      undefined,
      learningMutationAuthority(scope.userId),
      userMutationAuthority('another-user'),
      JSON.parse(JSON.stringify(f.authority)),
    ]) {
      await expect(
        f.publication.commit(scope, f.command, authority as MutationAuthority, f.proof),
      ).rejects.toThrow('HARNESS_AUTHORITY_REQUIRED');
    }
    expect(await db.select().from(agentHarnessHeads)).toHaveLength(0);
  });

  it('checks the live learning policy, while permitting an owner rollback when it is disabled', async () => {
    const f = await fixture();
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
    await expect(f.publication.commit(scope, f.command, f.authority, f.proof)).rejects.toThrow(
      'HARNESS_DISABLED',
    );
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
    await expect(
      f.publication.commit(
        scope,
        {
          action: 'rollback',
          id: 'rollback',
          expectedGeneration: 1,
          expectedActiveId: f.command.candidateId,
        },
        f.authority,
      ),
    ).resolves.toMatchObject({ generation: 2 });
    expect((await f.publication.resolve(f.source)).id).toBe(f.source.id);
  });

  it('uses publication generations to reject an ABA active pointer', async () => {
    const f = await fixture();
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    await f.publication.commit(
      scope,
      {
        action: 'rollback',
        id: 'rollback',
        expectedGeneration: 1,
        expectedActiveId: f.command.candidateId,
      },
      f.authority,
    );
    await f.publication.commit(
      scope,
      { ...f.command, id: 'adopt-again', expectedGeneration: 2 },
      f.authority,
      f.proof,
    );
    await expect(
      f.publication.commit(
        scope,
        {
          action: 'rollback',
          id: 'stale-rollback',
          expectedGeneration: 1,
          expectedActiveId: f.command.candidateId,
        },
        f.authority,
      ),
    ).rejects.toThrow('HARNESS_CAS_CONFLICT');
  });

  it('selects the displayed source when keeping, rather than an unshown earlier candidate', async () => {
    const f = await fixture();
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    await f.publication.commit(
      scope,
      {
        ...f.command,
        id: 'keep',
        action: 'keep',
        expectedGeneration: 1,
        expectedActiveId: f.command.candidateId,
      },
      f.authority,
      f.proof,
    );
    expect((await f.publication.resolve(f.source)).id).toBe(f.source.id);
    expect((await f.publication.read(scope)).active).toBeUndefined();
    expect(await f.publication.selection(f.source)).toMatchObject({
      publicationRef: { generation: 2, decisionId: 'keep' },
    });
    expect((await f.publication.decisions(scope))[1].episode?.selection?.selectedRevisionId).toBe(
      f.source.id,
    );
    expect((await f.publication.read(scope)).generation).toBe(2);
  });

  it('recovers notification failure without reverting adoption or repeating inference', async () => {
    const f = await fixture();
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error('private endpoint secret'))
      .mockResolvedValue(undefined);
    await f.publication.flushOutbox(scope, deliver);
    let [saved] = await db.select().from(agentHarnessDecisions);
    expect(saved).toMatchObject({
      deliveredAt: null,
      deliveryAttempts: 1,
      deliveryError: 'DELIVERY_FAILED',
    });
    expect((await f.publication.read(scope)).active?.id).toBe(f.command.candidateId);
    await new DatabaseHarnessPublication(db).flushOutbox(scope, deliver);
    [saved] = await db.select().from(agentHarnessDecisions);
    expect(saved.deliveredAt).toBeInstanceOf(Date);
    expect(saved.deliveryAttempts).toBe(2);
    await f.publication.flushOutbox(scope, deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0].id).toBe(deliver.mock.calls[1][0].id);
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it('mounts publication as a native Cordis service and dispatches outbox events after commit', async () => {
    const f = await fixture();
    const host = createImprovementHost(root, db);
    const listener = vi.fn();
    try {
      await host.run(async (ctx) => {
        ctx.on('qingzhou.improvement.published', listener);
        const publication = ctx.get('qingzhou.improvement.publications')!;
        await publication.commit(scope, f.command, f.authority, f.proof);
        await publication.flushOutbox(scope, (event) =>
          ctx.parallel('qingzhou.improvement.published', event),
        );
      });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ id: f.command.id, generation: 1 }),
      );
    } finally {
      await host.dispose();
    }
  });

  it('fences a late failed notification after another worker has reclaimed its expired lease', async () => {
    const f = await fixture();
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = f.publication.flushOutbox(scope, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('Late sender failed');
    });
    await ready;
    await db.update(agentHarnessDecisions).set({ leaseUntil: new Date(0) });
    await new DatabaseHarnessPublication(db).flushOutbox(scope, async () => undefined);
    release();
    await first;
    const [saved] = await db.select().from(agentHarnessDecisions);
    expect(saved.deliveredAt).toBeInstanceOf(Date);
    expect(saved.deliveryError).toBeNull();
    expect(saved.deliveryAttempts).toBe(2);
    expect(saved.leaseToken).toBeNull();
    expect(f.complete).toHaveBeenCalledTimes(9);
  });

  it('isolates accounts and removes database publication records with their owner', async () => {
    const f = await fixture();
    await f.publication.commit(scope, f.command, f.authority, f.proof);
    expect(await f.publication.read({ ...scope, userId: 'another-user' })).toEqual({
      generation: 0,
      cancelledExperiments: [],
    });
    await expect(
      f.publication.commit(
        { ...scope, userId: 'another-user' },
        f.command,
        userMutationAuthority('another-user'),
        f.proof,
      ),
    ).rejects.toThrow('HARNESS_SCOPE_NOT_FOUND');
    await db.delete(users).where(eq(users.id, scope.userId));
    expect(await db.select().from(agentHarnessHeads)).toHaveLength(0);
    expect(await db.select().from(agentHarnessDecisions)).toHaveLength(0);
  });
});
