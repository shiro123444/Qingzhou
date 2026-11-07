// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bindHarnessRun, resolveHarnessMaterial } from '@lobechat/agent-runtime';
import { type OperationSkillSet, SkillResolver } from '@lobechat/context-engine';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDocumentModel, PolicyLoad } from '@/database/models/agentDocuments';
import { agents, agentDocuments, documents, users } from '@/database/schemas';
import {
  bindOperationBehavior,
  restoreOperationHarness,
} from '@/server/services/agentRuntime/harness';
import {
  managedSkillIdentifier,
  resolveManagedSkills,
} from '@/server/services/agentRuntime/managedSkills';
import * as featureGate from '@/server/services/agentSignal/featureGate';
import { SkillManagementDocumentService } from '@/server/services/skillManagement';
import { PinnedSkillsExecutionRuntime } from '@/server/services/toolExecution/pinnedSkills';
import { skillsRuntime } from '@/server/services/toolExecution/serverRuntimes/skills';
import { activatorRuntime } from '@/server/services/toolExecution/serverRuntimes/activator';
import * as outcomes from '@/server/services/agentSignal/procedure';

import { createRuntimeExecutors } from '@/server/modules/AgentRuntime/RuntimeExecutors';

import { createChatProbePort } from './chat-probe';
import { applyHarnessPatch, HarnessCoordinator } from './coordinator';
import { userMutationAuthority } from './mutation-authority';
import { preparePublication, type PublicationCommand, validationDigest } from './publication';
import { DatabaseHarnessPublication } from './publication-store';
import { readCurrentHarnessSource } from './source';
import { FileHarnessStore } from './store';

const db = await getTestDB();
const scope = { userId: 'managed-owner', agentId: 'managed-agent' };
const originalBody = 'ORIGINAL_SKILL_BODY: answer using the original procedure.';
const candidateBody = 'CANDIDATE_SKILL_BODY: use a more precise procedure.';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qingzhou-managed-skill-'));
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
  vi.spyOn(featureGate, 'isAgentSignalEnabledForUser').mockResolvedValue(true);
  await db.insert(users).values({ id: scope.userId });
  await db.insert(agents).values({
    id: scope.agentId,
    userId: scope.userId,
    systemRole: 'Author instructions',
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
async function fixture(
  outcome: 'candidate' | 'baseline' | 'rejected' | 'unknown' = 'candidate',
  materialProvider = false,
) {
  const model = new AgentDocumentModel(db, scope.userId);
  const service = new SkillManagementDocumentService(
    db,
    scope.userId,
    undefined,
    userMutationAuthority(scope.userId),
  );
  const skill = await service.createSkill({
    agentId: scope.agentId,
    name: 'text-procedure',
    title: 'Text procedure',
    description: 'A standalone text procedure',
    bodyMarkdown: originalBody,
  });
  // Explicit user loading policy, independent of any experimental proposal.
  await model.updateToolLoadRule(skill.index.agentDocumentId, { mode: 'progressive' });
  const source = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
  const identifier = managedSkillIdentifier(skill.index.agentDocumentId);
  const coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  await coordinator.registerSource(source);
  const budget = {
    calls: 3,
    costMicros: 300,
    costMicrosPerCall: 100,
    deadlineMs: 15000,
    inputBytesPerCall: 32000,
    outputTokensPerCall: 128,
    tokens: 150000,
  };
  const experiment = await coordinator.propose(scope, {
    baselineId: source.id,
    patch: {
      baseRevisionId: source.id,
      surface: materialProvider ? 'context.skillMaterial' : 'managed.skillBody',
      ...(materialProvider ? {} : { targetBindingId: skill.index.agentDocumentId }),
      value: materialProvider ? 'skills.sections@1.0.0' : candidateBody,
    },
    tasks: [{ id: 'trial', prompt: 'Representative text task' }],
    heldout: [
      { id: 'unseen-a', prompt: 'Unseen text task A' },
      { id: 'unseen-b', prompt: 'Unseen text task B' },
    ],
    budget,
    validationBudget: { ...budget, calls: 6, costMicros: 600, tokens: 300000 },
  });
  const requests: any[] = [];
  const chat = vi.fn(async (payload: any, options: any) => {
    requests.push(payload);
    const text = JSON.stringify(payload.messages);
    const prompt = payload.messages.findLast((message: any) => message.role === 'user')?.content;
    let answer: string;
    if (text.includes('Compare the two answers')) {
      const compared = JSON.parse(prompt);
      const preferCandidate =
        outcome === 'candidate' || (outcome === 'rejected' && !compared.task.startsWith('Unseen'));
      const target = preferCandidate ? 'improved result' : 'original result';
      answer =
        outcome === 'unknown'
          ? 'unavailable evaluation'
          : JSON.stringify({
              choice: compared.A === target ? 'A' : 'B',
              reason: 'Deterministic transport fixture',
            });
    } else
      answer =
        text.includes('CANDIDATE_SKILL_BODY') || text.includes('qingzhou.skill-sections.v1')
          ? 'improved result'
          : 'original result';
    await options.callback.onText(answer);
    return new Response('');
  });
  const port = createChatProbePort({
    model: 'model',
    provider: 'provider',
    runtime: { chat },
    activatedSkillIds: [identifier],
  });
  const publication = new DatabaseHarnessPublication(db);
  const authority = userMutationAuthority(scope.userId);
  const command = async (action: 'adopt' | 'keep' = 'adopt'): Promise<PublicationCommand> => ({
    id: `explicit-${action}`,
    action,
    experimentId: experiment.id,
    candidateId: experiment.candidateId,
    expectedGeneration: 0,
    expectedSourceId: source.id,
    expectedSourceGeneration: (source.material.agentConfig as { generation: number }).generation,
    validationDigest: await validationDigest(
      (await coordinator.store.read(scope)).experiments[experiment.id],
    ),
  });
  const finish = async () => {
    await coordinator.execute(scope, experiment.id, port);
    return coordinator.execute(scope, experiment.id, port, { validate: true });
  };
  return {
    model,
    service,
    skill,
    source,
    identifier,
    coordinator,
    experiment,
    requests,
    chat,
    port,
    publication,
    authority,
    command,
    finish,
  };
}
function activation(skills: OperationSkillSet) {
  return new PinnedSkillsExecutionRuntime(
    {
      service: {
        findAll: async () => ({ data: [], total: 0 }),
        findById: async () => undefined,
        findByName: async () => undefined,
        readResource: async () => {
          throw new Error('No resources');
        },
      },
    },
    {
      agentId: scope.agentId,
      userId: scope.userId,
      serverDB: db,
      toolManifestMap: {},
      operationSkillSet: skills,
    },
  );
}

describe('managed text skill: actual context, private comparison and explicit publication', () => {
  it.each(['candidate', 'baseline', 'rejected', 'unknown'] as const)(
    'validates and records the versioned parser for %s without modifying author documents',
    async (outcome) => {
      const f = await fixture(outcome, true);
      const result = await f.finish();
      expect(result.validation).toBe(
        outcome === 'candidate' ? 'passed' : outcome === 'unknown' ? 'unknown' : 'rejected',
      );
      expect(f.chat).toHaveBeenCalledTimes(9);
      expect(JSON.stringify(f.requests[0].messages)).not.toContain('qingzhou.skill-sections.v1');
      expect(JSON.stringify(f.requests[1].messages)).toContain('qingzhou.skill-sections.v1');
      for (const index of [2, 5, 8])
        expect(JSON.stringify(f.requests[index].messages)).not.toContain(f.identifier);
      const adopt = await f.command();
      if (outcome !== 'candidate')
        await expect(preparePublication(f.coordinator.store, scope, adopt)).rejects.toThrow(
          'HARNESS_NOT_VALIDATED',
        );
      const command = outcome === 'candidate' ? adopt : await f.command('keep');
      await f.publication.commit(
        scope,
        command,
        f.authority,
        await preparePublication(f.coordinator.store, scope, command),
      );
      expect((await f.model.findById(f.skill.index.agentDocumentId))?.content).toContain(
        originalBody,
      );
      const selected = await f.publication.selection(f.source);
      expect((selected.revision.material.contextPolicy as any).skillMaterial.manifest.id).toBe(
        outcome === 'candidate' ? 'skills.sections' : 'skills.raw',
      );
      const decisions = await f.publication.decisions(scope);
      expect(decisions[0].learning?.configurations).toHaveLength(2);
      expect(decisions[0].learning?.episode.selection?.type).toBe('behavior-activation');
      if (outcome === 'candidate') {
        const bound = await bindHarnessRun(selected.revision, 'pinned-before-rollback', {
          agentConfig: f.source.material.agentConfig,
          promptSegments: [{ kind: 'author', content: 'Author instructions' }],
        });
        await f.publication.commit(
          scope,
          {
            action: 'rollback',
            id: 'rollback-parser',
            expectedGeneration: 1,
            expectedActiveId: selected.revision.id,
          },
          f.authority,
        );
        expect((await f.publication.selection(f.source)).revision.id).toBe(f.source.id);
        expect((resolveHarnessMaterial(bound).contextPolicy as any).skillMaterial.manifest.id).toBe(
          'skills.sections',
        );
      }
    },
  );
  it('compiles distinct bodies into real probe requests, keeps the selector blind, and publishes an immutable overlay', async () => {
    const f = await fixture();
    const result = await f.finish();
    expect(result.validation).toBe('passed');
    expect(f.chat).toHaveBeenCalledTimes(9);
    const first = JSON.stringify(f.requests[0].messages),
      second = JSON.stringify(f.requests[1].messages);
    expect(first).toContain(originalBody);
    expect(first).not.toContain(candidateBody);
    expect(second).toContain(candidateBody);
    expect(second).not.toContain(originalBody);
    for (const index of [2, 5, 8]) {
      const messages = JSON.stringify(f.requests[index].messages);
      expect(messages).not.toContain('SKILL_BODY');
      expect(messages).not.toContain(f.identifier);
      expect(messages).not.toContain('Author instructions');
    }
    const command = await f.command();
    await f.publication.commit(
      scope,
      command,
      f.authority,
      await preparePublication(f.coordinator.store, scope, command),
    );
    expect((await f.model.findById(f.skill.index.agentDocumentId))?.content).toContain(
      originalBody,
    );
    expect((await f.model.findById(f.skill.index.agentDocumentId))?.policyLoad).toBe(
      PolicyLoad.PROGRESSIVE,
    );
    expect((await readCurrentHarnessSource(db, scope.userId, scope.agentId)).id).toBe(f.source.id);
    const captured = await bindHarnessRun(f.source, 'normal-operation', {
      agentConfig: f.source.material.agentConfig,
      modelRuntimeConfig: f.source.material.modelRuntimeConfig,
      toolCatalog: { tools: [], manifestMap: {} },
      promptSegments: [{ kind: 'author', content: 'Author instructions' }],
      operationSkillSet: f.source.material.operationSkillSet,
    });
    const selected = await f.publication.selection(f.source);
    const bound = await bindOperationBehavior(captured, selected.revision, selected.publicationRef);
    const state: any = { metadata: { agentId: scope.agentId, harness: bound } };
    await restoreOperationHarness(state, 'normal-operation', scope.userId);
    expect(
      state.metadata.operationSkillSet.skills.find((s: any) => s.identifier === f.identifier)
        .content,
    ).toContain(candidateBody);
    expect(
      state.metadata.pinnedAgentDocuments.some((d: any) => d.id === f.skill.index.agentDocumentId),
    ).toBe(false);
    const activated = await activation(state.metadata.operationSkillSet).activateSkill({
      name: f.identifier,
    });
    expect(activated.content).toContain(candidateBody);
    const context = {
      agentId: scope.agentId,
      userId: scope.userId,
      serverDB: db,
      toolManifestMap: {},
      operationSkillSet: state.metadata.operationSkillSet,
    };
    expect(
      (await (await skillsRuntime.factory(context)).activateSkill({ name: f.identifier })).content,
    ).toContain(candidateBody);
    vi.spyOn(outcomes, 'emitToolOutcomeSafely').mockResolvedValue(undefined);
    expect(
      (await (await activatorRuntime.factory(context)).activateSkill({ name: f.identifier }))
        .content,
    ).toContain(candidateBody);
    const resolved = new SkillResolver().resolve(state.metadata.operationSkillSet, {
      activatedSkills: [
        { identifier: f.identifier, content: 'A later live body must not override the snapshot' },
      ],
    });
    expect(resolved.enabledSkills.find((s) => s.identifier === f.identifier)?.content).toContain(
      candidateBody,
    );
    await f.model.update(f.skill.index.agentDocumentId, { content: 'A later manual body' });
    const changed = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
    expect((await f.publication.selection(changed)).revision.id).toBe(changed.id);
    expect(
      (await activation(state.metadata.operationSkillSet).activateSkill({ name: f.identifier }))
        .content,
    ).toContain(candidateBody);
    expect(
      (
        await activation(
          f.source.material.operationSkillSet as unknown as OperationSkillSet,
        ).activateSkill({ name: f.identifier })
      ).content,
    ).toContain(originalBody);
    expect(resolveHarnessMaterial(bound).operationSkillSet).toEqual(
      state.metadata.operationSkillSet,
    );
    expect(f.chat).toHaveBeenCalledTimes(9);
  });

  it.each(['baseline', 'rejected', 'unknown'] as const)(
    'retains the source for %s evidence and never promotes it through keep',
    async (outcome) => {
      const f = await fixture(outcome);
      const result = await f.finish();
      expect(result.validation).toBe(outcome === 'unknown' ? 'unknown' : 'rejected');
      const adopt = await f.command();
      await expect(preparePublication(f.coordinator.store, scope, adopt)).rejects.toThrow(
        'HARNESS_NOT_VALIDATED',
      );
      const keep = await f.command('keep');
      await f.publication.commit(
        scope,
        keep,
        f.authority,
        await preparePublication(f.coordinator.store, scope, keep),
      );
      expect((await f.publication.resolve(f.source)).id).toBe(f.source.id);
      expect((await f.publication.decisions(scope))[0].episode).toMatchObject({
        outcome: 'baseline',
        validation: result.validation,
      });
      expect((await f.model.findById(f.skill.index.agentDocumentId))?.content).toContain(
        originalBody,
      );
      expect(f.chat).toHaveBeenCalledTimes(9);
    },
  );

  it.each(['content', 'aba', 'policy', 'permission'] as const)(
    'rejects a concurrent %s change without modifying the resource or repeating inference',
    async (kind) => {
      const f = await fixture();
      await f.finish();
      const command = await f.command();
      const proof = await preparePublication(f.coordinator.store, scope, command);
      if (kind === 'content' || kind === 'aba') {
        await f.model.update(f.skill.index.agentDocumentId, {
          content: 'Concurrent manual content',
        });
        if (kind === 'aba')
          await f.model.update(f.skill.index.agentDocumentId, { content: f.skill.content });
      } else if (kind === 'policy')
        await f.model.update(f.skill.index.agentDocumentId, { policyLoad: PolicyLoad.DISABLED });
      else {
        await db
          .update(agentDocuments)
          .set({ accessSelf: 0 })
          .where(eq(agentDocuments.id, f.skill.index.agentDocumentId));
        expect((await f.model.findById(f.skill.index.agentDocumentId))?.accessSelf).toBe(0);
      }
      await expect(f.publication.commit(scope, command, f.authority, proof)).rejects.toThrow(
        'HARNESS_STALE_SOURCE',
      );
      expect((await f.publication.read(scope)).generation).toBe(0);
      expect(f.chat).toHaveBeenCalledTimes(9);
    },
  );
  it('rejects parser adoption when any source resource has changed, without repeating paid inference', async () => {
    const f = await fixture('candidate', true);
    await f.finish();
    const command = await f.command();
    const proof = await preparePublication(f.coordinator.store, scope, command);
    await f.model.update(f.skill.index.agentDocumentId, { content: 'Concurrent manual text' });
    await expect(f.publication.commit(scope, command, f.authority, proof)).rejects.toThrow(
      'HARNESS_STALE_SOURCE',
    );
    expect((await f.publication.read(scope)).generation).toBe(0);
    expect(f.chat).toHaveBeenCalledTimes(9);
  });

  it('honors cancellation before model admission and before publication, without refunding or retrying calls', async () => {
    const f = await fixture();
    await f.coordinator.store.cancel(scope, f.experiment.id);
    const result = await f.coordinator.execute(scope, f.experiment.id, f.port);
    expect(result.status).toBe('cancelled');
    expect(f.chat).not.toHaveBeenCalled();
    await f.publication.cancel(scope, f.experiment.id, f.authority);
    await expect(preparePublication(f.coordinator.store, scope, await f.command())).rejects.toThrow(
      'HARNESS_CANCELLED',
    );
  });

  it('stops at the existing charged budget when a real compiled request exceeds its input bound', async () => {
    const f = await fixture();
    await f.coordinator.store.transaction(scope, async (state, save) => {
      state.experiments[f.experiment.id].budget.inputBytesPerCall = 1024;
      await save();
    });
    const result = await f.coordinator.execute(scope, f.experiment.id, f.port);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('HARNESS_PROBE_FAILED');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].chargedTokens).toBeGreaterThan(0);
    expect(f.chat).not.toHaveBeenCalled();
  });

  it('rejects frontmatter edits and foreign skill targets', async () => {
    const f = await fixture();
    const patch = f.experiment.patch;
    expect(
      await resolveManagedSkills(await f.model.findByAgent(scope.agentId), {
        ...scope,
        userId: 'stranger',
      }),
    ).toEqual([]);
    await expect(
      applyHarnessPatch(f.source, { ...patch, value: '---\nname: replaced\n---\nBody' }),
    ).rejects.toThrow('HARNESS_INVALID_SKILL_BODY');
    await expect(
      applyHarnessPatch(f.source, { ...patch, targetBindingId: 'foreign-binding' }),
    ).rejects.toThrow('HARNESS_SKILL_NOT_ELIGIBLE');
  });

  it.each(['disabled', 'resource', 'conditional', 'bounded'] as const)(
    'excludes %s targets without changing their loading policies',
    async (mode) => {
      const f = await fixture();
      const patch = f.experiment.patch;
      if (mode === 'disabled')
        await f.model.update(f.skill.index.agentDocumentId, { policyLoad: PolicyLoad.DISABLED });
      else if (mode === 'resource') {
        await f.model.update(f.skill.index.agentDocumentId, { policyLoad: PolicyLoad.PROGRESSIVE });
        await f.model.create(scope.agentId, 'helper.py', 'print("not executed")', {
          parentId: f.skill.bundle.documentId,
        });
      } else if (mode === 'conditional') {
        await db
          .update(agentDocuments)
          .set({ policy: { context: { rule: 'by-keywords', keywords: ['only-here'] } } })
          .where(eq(agentDocuments.id, f.skill.index.agentDocumentId));
      } else {
        await db
          .update(agentDocuments)
          .set({ policy: { context: { rule: 'always', maxTokens: 16 } } })
          .where(eq(agentDocuments.id, f.skill.index.agentDocumentId));
      }
      const source = await readCurrentHarnessSource(db, scope.userId, scope.agentId);
      await expect(
        applyHarnessPatch(source, { ...patch, baseRevisionId: source.id }),
      ).rejects.toThrow('HARNESS_SKILL_NOT_ELIGIBLE');
    },
  );

  it('retains the charged in-flight reservation and scope lease until cancelled transport drains', async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void, modelSignal!: AbortSignal;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.chat.mockImplementationOnce(async (_payload, options) => {
      modelSignal = options.signal;
      entered();
      await drained;
      return new Response('');
    });
    const running = f.coordinator.execute(scope, f.experiment.id, f.port);
    await ready;
    await f.coordinator.store.cancel(scope, f.experiment.id);
    await f.publication.cancel(scope, f.experiment.id, f.authority);
    try {
      await vi.waitFor(() => expect(modelSignal.aborted).toBe(true));
      await expect(f.coordinator.store.transaction(scope, async () => undefined)).rejects.toThrow(
        'HARNESS_BUSY',
      );
    } finally {
      release();
    }
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].chargedTokens).toBeGreaterThan(0);
    expect(f.chat).toHaveBeenCalledTimes(1);
    expect((await f.model.findById(f.skill.index.agentDocumentId))?.content).toContain(
      originalBody,
    );
  });

  it.each(['disabled', 'read-revoked'] as const)(
    'keeps %s and missing pinned resources live, and never falls back to the latest body',
    async (mode) => {
      const f = await fixture();
      const skills = f.source.material.operationSkillSet as unknown as OperationSkillSet;
      if (mode === 'disabled')
        await f.model.update(f.skill.index.agentDocumentId, { policyLoad: PolicyLoad.DISABLED });
      else
        await db
          .update(agentDocuments)
          .set({ accessSelf: 0 })
          .where(eq(agentDocuments.id, f.skill.index.agentDocumentId));
      await expect(activation(skills).activateSkill({ name: f.identifier })).rejects.toThrow(
        'HARNESS_PINNED_SKILL_UNAVAILABLE',
      );
      const executors = createRuntimeExecutors({
        serverDB: db,
        userId: scope.userId,
        operationId: 'old-operation',
        stepIndex: 2,
      } as any);
      await expect(
        executors.call_llm!(
          {
            type: 'call_llm',
            payload: { model: 'model', provider: 'provider', messages: [] },
          } as any,
          {
            metadata: { agentId: scope.agentId, operationSkillSet: skills },
            activatedStepSkills: [{ identifier: f.identifier, activatedAtStep: 1 }],
          } as any,
        ),
      ).rejects.toThrow('HARNESS_PINNED_SKILL_UNAVAILABLE');
      await expect(
        activation({ ...skills, skills: [] }).activateSkill({ name: f.identifier }),
      ).rejects.toThrow('HARNESS_PINNED_SKILL_UNAVAILABLE');
      await db.delete(documents).where(eq(documents.id, f.skill.index.documentId));
      await expect(activation(skills).activateSkill({ name: f.identifier })).rejects.toThrow(
        'HARNESS_PINNED_SKILL_UNAVAILABLE',
      );
    },
  );
});
