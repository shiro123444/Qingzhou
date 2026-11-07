import { DatabaseLearningBudget } from '@/server/runtime/improvement/budget-store';
// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHarnessRevision } from '@lobechat/agent-runtime';
import { AgentDocumentModel } from '@/database/models/agentDocuments';
import { resolveManagedSkills } from '@/server/services/agentRuntime/managedSkills';
import { SkillManagementDocumentService } from '@/server/services/skillManagement';
import { userMutationAuthority } from '@/server/runtime/improvement/mutation-authority';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { HarnessCoordinator } from '@/server/runtime/improvement/coordinator';
import * as production from '@/server/runtime/improvement/production';
import { DatabaseHarnessPublication } from '@/server/runtime/improvement/publication-store';
import { agents, users } from '@/database/schemas';
import { FileHarnessStore } from '@/server/runtime/improvement/store';
import * as featureGate from '@/server/services/agentSignal/featureGate';

import { agentHarnessRouter } from './agentHarness';

const fake = vi.hoisted(() => ({ systemRole: 'original' }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn().mockResolvedValue({}) }));
vi.mock('@/database/models/agent', () => ({
  AgentModel: class {
    constructor(
      _db: unknown,
      private readonly userId: string,
    ) {}
    getAgentConfig = async (id: string) =>
      this.userId === 'owner' && id === 'agent'
        ? {
            id: 'agent',
            systemRole: fake.systemRole,
            chatConfig: { autoCreateTopicThreshold: 2, selfIteration: { enabled: true } },
          }
        : null;
  },
}));

const callerFactory = createCallerFactory(agentHarnessRouter);
const scope = { userId: 'owner', agentId: 'agent' };
const db = await getTestDB();
const budget = {
  calls: 3,
  outputTokensPerCall: 512,
  inputBytesPerCall: 32000,
  deadlineMs: 5000,
  tokens: 120000,
  costMicrosPerCall: 50000,
  costMicros: 150000,
};
let root: string;
let coordinator: HarnessCoordinator;
let baseId: string;
let publication: DatabaseHarnessPublication;
let extraMaterial: Record<string, unknown>;
const material = () => ({
  agentConfig: { systemRole: fake.systemRole, generation: 0 },
  modelRuntimeConfig: { model: 'model', provider: 'provider' },
  configurationComplete: true,
  ...extraMaterial,
});
beforeEach(async () => {
  fake.systemRole = 'original';
  extraMaterial = {};
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
  root = await mkdtemp(path.join(tmpdir(), 'qingzhou-harness-rpc-'));
  coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  await db.insert(users).values({ id: scope.userId });
  await db.insert(agents).values({
    id: scope.agentId,
    userId: scope.userId,
    systemRole: 'original',
    chatConfig: { autoCreateTopicThreshold: 2, selfIteration: { enabled: true } },
  });
  const base = await createHarnessRevision(scope, material(), 2);
  baseId = base.id;
  publication = new DatabaseHarnessPublication(db, async () =>
    createHarnessRevision(scope, material(), 2),
  );
  await coordinator.registerSource(base);
  vi.spyOn(production, 'withLearningBudget').mockImplementation((_db, run) =>
    run(new DatabaseLearningBudget(db)),
  );
  vi.spyOn(production, 'withHarnessCoordinator').mockImplementation((run) => run(coordinator));
  vi.spyOn(production, 'withHarnessPublication').mockImplementation((_db, run) =>
    run(publication, (scope) => publication.flushOutbox(scope, async () => undefined)),
  );
  vi.spyOn(featureGate, 'isAgentSignalEnabledForUser').mockResolvedValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await db.delete(users).where(eq(users.id, scope.userId));
});
describe('authenticated harness transport', () => {
  it.each(['body', 'parser'] as const)(
    'carries a managed %s through registration, real probe assembly, viewed confirmation and server-only adoption',
    async (mode) => {
      const documents = new AgentDocumentModel(db, scope.userId);
      const skill = await new SkillManagementDocumentService(
        db,
        scope.userId,
        undefined,
        userMutationAuthority(scope.userId),
      ).createSkill({
        agentId: scope.agentId,
        name: 'text-procedure',
        title: 'Text procedure',
        description: 'A text procedure',
        bodyMarkdown: 'ORIGINAL_TEXT_PROCEDURE',
      });
      await documents.updateToolLoadRule(skill.index.agentDocumentId, { mode: 'progressive' });
      const docs = await documents.findByAgent(scope.agentId);
      extraMaterial = {
        agentDocuments: docs,
        operationSkillSet: {
          skills: await resolveManagedSkills(docs, scope),
          enabledPluginIds: [],
        },
      };
      const source = await createHarnessRevision(scope, material(), 2);
      await coordinator.registerSource(source);
      const owner = callerFactory(await createContextInner({ userId: scope.userId }));
      const first = await owner.get({ agentId: scope.agentId });
      expect(first.state.managedSkills).toMatchObject([
        {
          bindingId: skill.index.agentDocumentId,
          body: expect.stringContaining('ORIGINAL_TEXT_PROCEDURE'),
        },
      ]);
      await owner.command({
        agentId: scope.agentId,
        command: {
          action: 'propose',
          baselineId: source.id,
          surface: mode === 'parser' ? 'context.skillMaterial' : 'managed.skillBody',
          ...(mode === 'body' ? { targetBindingId: skill.index.agentDocumentId } : {}),
          systemRole: mode === 'parser' ? 'skills.sections@1.0.0' : 'CANDIDATE_TEXT_PROCEDURE',
          tasks: [{ id: 'trial', prompt: 'Representative task' }],
          heldout: [
            { id: 'a', prompt: 'Unseen task A' },
            { id: 'b', prompt: 'Unseen task B' },
          ],
          budget,
          validationBudget: { ...budget, calls: 6, tokens: 240000, costMicros: 300000 },
        },
      });
      const experiment = Object.values((await coordinator.store.read(scope)).experiments)[0];
      const requests: any[] = [];
      const model = await import('@/server/modules/ModelRuntime');
      vi.spyOn(model, 'initModelRuntimeFromDB').mockResolvedValue({
        chat: async (payload: any, options: any) => {
          requests.push(payload);
          const text = JSON.stringify(payload.messages);
          const user = payload.messages.findLast(
            (message: any) => message.role === 'user',
          )?.content;
          const answers = text.includes('Compare the two answers') ? JSON.parse(user) : null;
          await options.callback.onText(
            answers
              ? JSON.stringify({
                  choice: answers.A === 'improved' ? 'A' : 'B',
                  reason: 'Transport fixture',
                })
              : text.includes('CANDIDATE_TEXT_PROCEDURE') ||
                  text.includes('qingzhou.skill-sections.v1')
                ? 'improved'
                : 'original',
          );
          return new Response('');
        },
      } as any);
      await owner.command({
        agentId: scope.agentId,
        command: { action: 'run', experimentId: experiment.id },
      });
      await owner.command({
        agentId: scope.agentId,
        command: { action: 'validate', experimentId: experiment.id },
      });
      const view = await owner.get({ agentId: scope.agentId });
      expect(view.state.experiments[experiment.id]).toMatchObject({
        validation: 'passed',
        ...(mode === 'body'
          ? { skillBaselineBody: expect.stringContaining('ORIGINAL_TEXT_PROCEDURE') }
          : { materialBaselineProvider: 'skills.raw@1.0.0' }),
      });
      await owner.command({
        agentId: scope.agentId,
        command: {
          action: 'adopt',
          id: randomUUID(),
          experimentId: experiment.id,
          candidateId: experiment.candidateId,
          expectedGeneration: view.state.publicationGeneration,
          expectedSourceId: source.id,
          expectedSourceGeneration: 0,
          validationDigest: view.state.experiments[experiment.id].validationDigest,
        },
      });
      expect((await publication.read(scope)).active?.id).toBe(experiment.candidateId);
      expect((await documents.findById(skill.index.agentDocumentId))?.content).toContain(
        'ORIGINAL_TEXT_PROCEDURE',
      );
      expect(requests).toHaveLength(9);
      expect(JSON.stringify(requests[1].messages)).toContain(
        mode === 'body' ? 'CANDIDATE_TEXT_PROCEDURE' : 'qingzhou.skill-sections.v1',
      );
      if (mode === 'parser')
        expect(
          Object.keys(
            (
              await new DatabaseLearningBudget(db).read(
                {
                  userId: scope.userId,
                  subject: { kind: 'agent', agentId: scope.agentId },
                },
                `chat:${experiment.id}`,
              )
            ).attempts,
          ),
        ).toHaveLength(9);
      expect(
        await owner.resolveClient({
          agentId: scope.agentId,
          systemRole: 'original',
          model: 'model',
          provider: 'provider',
        }),
      ).toBeNull();
    },
  );
  it('rejects outdated sources before initializing any paid model runtime', async () => {
    const owner = callerFactory(await createContextInner({ userId: scope.userId }));
    await owner.command({
      agentId: scope.agentId,
      command: {
        action: 'propose',
        baselineId: baseId,
        systemRole: 'candidate',
        tasks: [{ id: 'trial', prompt: 'Representative' }],
        heldout: [
          { id: 'a', prompt: 'Unseen A' },
          { id: 'b', prompt: 'Unseen B' },
        ],
        budget,
        validationBudget: { ...budget, calls: 6, tokens: 240000, costMicros: 300000 },
      },
    });
    const state = await coordinator.store.read(scope);
    const experiment = Object.values(state.experiments)[0];
    fake.systemRole = 'Concurrent edit';
    const model = await import('@/server/modules/ModelRuntime');
    const initialize = vi.spyOn(model, 'initModelRuntimeFromDB');
    await expect(
      owner.command({
        agentId: scope.agentId,
        command: { action: 'run', experimentId: experiment.id },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(initialize).not.toHaveBeenCalled();
    expect((await owner.get({ agentId: scope.agentId })).state.sourceCurrent).toBe(false);
    expect((await coordinator.store.read(scope)).experiments[experiment.id].attempts).toHaveLength(
      0,
    );
  });

  it('keeps legacy evidence readable while requiring recapture before publication', async () => {
    const legacy = await createHarnessRevision(scope, material(), 1);
    await coordinator.registerSource(legacy);
    const experiment = await coordinator.propose(scope, {
      baselineId: legacy.id,
      patch: { baseRevisionId: legacy.id, surface: 'chat.systemRole', value: 'candidate' },
      tasks: [{ id: 'trial', prompt: 'Representative' }],
      heldout: [
        { id: 'a', prompt: 'Unseen A' },
        { id: 'b', prompt: 'Unseen B' },
      ],
      budget,
      validationBudget: { ...budget, calls: 6, tokens: 240000, costMicros: 300000 },
    });
    const owner = callerFactory(await createContextInner({ userId: scope.userId }));
    const view = await owner.get({ agentId: scope.agentId });
    expect(view.state.experiments[experiment.id].patch.value).toBe('candidate');
    expect(view.state.sourceCurrent).toBe(false);
    await expect(
      owner.command({
        agentId: scope.agentId,
        command: {
          action: 'adopt',
          id: randomUUID(),
          experimentId: experiment.id,
          candidateId: experiment.candidateId,
          expectedGeneration: 0,
          expectedSourceId: legacy.id,
          expectedSourceGeneration: 0,
          validationDigest: view.state.experiments[experiment.id].validationDigest,
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'HARNESS_SOURCE_RECAPTURE_REQUIRED' });
    expect((await coordinator.store.read(scope)).revisions[legacy.id]).toEqual(legacy);
    expect((await publication.read(scope)).generation).toBe(0);
  });

  it('requires authentication, ownership and the learning gate', async () => {
    const anonymous = callerFactory(await createContextInner({}));
    await expect(anonymous.get({ agentId: 'agent' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const stranger = callerFactory(await createContextInner({ userId: 'stranger' }));
    await expect(stranger.get({ agentId: 'agent' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const owner = callerFactory(await createContextInner({ userId: 'owner' }));
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
    expect(await owner.get({ agentId: 'agent' })).toMatchObject({ enabled: false });
    await expect(
      owner.command({
        agentId: 'agent',
        command: {
          action: 'run',
          experimentId: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('binds confirmation to viewed validation, publication generations and compatible client instructions', async () => {
    const owner = callerFactory(await createContextInner({ userId: 'owner' }));
    await owner.command({
      agentId: 'agent',
      command: {
        action: 'propose',
        baselineId: baseId,
        systemRole: 'candidate',
        tasks: [{ id: 'train', prompt: 'representative' }],
        heldout: [
          { id: 'a', prompt: 'unseen one' },
          { id: 'b', prompt: 'unseen two' },
        ],
        budget,
        validationBudget: { ...budget, calls: 6, tokens: 240000, costMicros: 300000 },
      },
    });
    const experiment = Object.values((await coordinator.store.read(scope)).experiments)[0];
    const before = await owner.get({ agentId: scope.agentId });
    await expect(
      owner.command({
        agentId: 'agent',
        command: {
          action: 'adopt',
          id: randomUUID(),
          experimentId: experiment.id,
          candidateId: experiment.candidateId,
          reason: 'unvalidated',
          expectedGeneration: before.state.publicationGeneration,
          expectedSourceId: baseId,
          expectedSourceGeneration: before.state.sourceGeneration,
          validationDigest: before.state.experiments[experiment.id].validationDigest,
        },
      }),
    ).rejects.toThrow('HARNESS_EXPERIMENT_INCOMPLETE');
    const port = {
      complete: async ({ system, prompt }: { system: string; prompt: string }) => {
        const data = system.startsWith('Compare') ? JSON.parse(prompt) : null;
        return {
          text: data
            ? JSON.stringify({ choice: data.A === 'candidate' ? 'A' : 'B', reason: 'fixture' })
            : system,
        };
      },
    };
    await coordinator.execute(scope, experiment.id, port);
    await coordinator.execute(scope, experiment.id, port, { validate: true });
    const viewed = await owner.get({ agentId: scope.agentId });
    await owner.command({
      agentId: 'agent',
      command: {
        action: 'adopt',
        id: randomUUID(),
        experimentId: experiment.id,
        candidateId: experiment.candidateId,
        reason: 'Explicit owner selection',
        expectedGeneration: viewed.state.publicationGeneration,
        expectedSourceId: baseId,
        expectedSourceGeneration: viewed.state.sourceGeneration,
        validationDigest: viewed.state.experiments[experiment.id].validationDigest,
      },
    });
    expect(
      await owner.resolveClient({
        agentId: 'agent',
        systemRole: 'original',
        model: 'model',
        provider: 'provider',
      }),
    ).toEqual({ revisionId: experiment.candidateId, systemRole: 'candidate' });
    vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
    expect(
      await owner.resolveClient({
        agentId: 'agent',
        systemRole: 'original',
        model: 'model',
        provider: 'provider',
      }),
    ).toEqual({ revisionId: experiment.candidateId, systemRole: 'candidate' });
    expect(
      await owner.resolveClient({
        agentId: 'agent',
        systemRole: 'original',
        model: 'different-model',
        provider: 'provider',
      }),
    ).toBeNull();
    fake.systemRole = 'concurrent user edit';
    expect(
      await owner.resolveClient({
        agentId: 'agent',
        systemRole: 'original',
        model: 'model',
        provider: 'provider',
      }),
    ).toBeNull();
    await owner.command({
      agentId: 'agent',
      command: {
        action: 'rollback',
        id: randomUUID(),
        expectedActiveId: experiment.candidateId,
        expectedGeneration: 1,
        reason: 'Owner rollback while learning is disabled',
      },
    });
    expect((await coordinator.store.read(scope)).active).toBeUndefined();
    expect(await publication.read(scope)).toMatchObject({ generation: 2, active: undefined });
  });
});
