// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  composeHarnessPrompt,
  type HarnessPromptSegment,
  resolveHarnessMaterial,
  verifyHarness,
} from '@lobechat/agent-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { createChatProbePort } from '@/server/runtime/improvement/chat-probe';
import { applyHarnessPatch } from '@/server/runtime/improvement/coordinator';
import { HarnessCoordinator } from '@/server/runtime/improvement/coordinator';
import { FileHarnessStore } from '@/server/runtime/improvement/store';

import {
  bindOperationBehavior,
  captureOperationHarness,
  restoreOperationHarness,
} from '../harness';
import type { OperationCreationParams } from '../types';

const scope = { userId: 'owner', agentId: 'agent' };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function input(flavor: 'chat' | 'page' | 'task' = 'chat'): OperationCreationParams {
  const agentConfig = {
    model: 'model',
    provider: 'provider',
    plugins: ['authored-plugin'],
    systemRole: 'Original author instructions',
    params: { temperature: 0.2 },
  };
  const promptSegments: HarnessPromptSegment[] = [
    { kind: 'author', content: agentConfig.systemRole },
  ];
  if (flavor !== 'chat')
    promptSegments.push({ kind: 'host', content: `${flavor} host constraints` });
  promptSegments.push({ kind: 'task', content: `private ${flavor} request` });
  return {
    agentConfig: {
      ...agentConfig,
      plugins: [...agentConfig.plugins, `${flavor}-runtime-plugin`],
      systemRole: composeHarnessPrompt(promptSegments),
    },
    agentDocuments: [],
    appContext: { ...scope, scope: flavor, topicId: `private-${flavor}-topic` },
    harnessSource: { agentConfig, promptSegments },
    initialContext: { phase: 'user_input', payload: { privateTask: flavor } } as any,
    initialMessages: [{ role: 'user', content: `private ${flavor} message` }],
    modelRuntimeConfig: { model: 'model', provider: 'provider' },
    operationId: `${flavor}-operation`,
    operationSkillSet: {
      skills: [{ identifier: 'skill', name: 'Skill', description: 'Skill', content: 'Full skill' }],
      enabledPluginIds: ['authored-plugin', `${flavor}-runtime-plugin`],
    },
    toolSet: {
      enabledToolIds: [`${flavor}-tool`],
      manifestMap: {},
      tools: [{ function: { name: `${flavor}-tool` } }],
    },
    userId: scope.userId,
  };
}
async function adopted() {
  const root = await mkdtemp(path.join(tmpdir(), 'qingzhou-behavior-'));
  roots.push(root);
  const coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  const captured = await captureOperationHarness(input());
  await coordinator.registerSource(captured.revision);
  const budget = {
    calls: 3,
    costMicros: 300,
    costMicrosPerCall: 100,
    tokens: 15000,
    inputBytesPerCall: 1024,
    outputTokensPerCall: 128,
    deadlineMs: 5000,
  };
  const experiment = await coordinator.propose(scope, {
    baselineId: captured.revision.id,
    patch: {
      baseRevisionId: captured.revision.id,
      surface: 'chat.systemRole',
      value: 'Candidate author instructions',
    },
    tasks: [{ id: 'train', prompt: 'A representative text task' }],
    heldout: [
      { id: 'unseen-a', prompt: 'A new text task' },
      { id: 'unseen-b', prompt: 'Another new text task' },
    ],
    budget,
    validationBudget: { ...budget, calls: 6, costMicros: 600, tokens: 30000 },
  });
  // Deterministic selection tests admission/commit mechanics, not business quality.
  const port = {
    complete: async ({ system, prompt }: { system: string; prompt: string }) => {
      const answers = system.startsWith('Compare') ? JSON.parse(prompt) : undefined;
      return {
        text: answers
          ? JSON.stringify({
              choice: answers.A.startsWith('Candidate') ? 'A' : 'B',
              reason: 'fixture',
            })
          : system,
      };
    },
  };
  await coordinator.execute(scope, experiment.id, port);
  await coordinator.execute(scope, experiment.id, port, { validate: true });
  await coordinator.decide(scope, {
    id: 'explicit-choice',
    action: 'adopt',
    experimentId: experiment.id,
    candidateId: experiment.candidateId,
  });
  return { coordinator, captured, experiment };
}

describe('behavior identity and per-operation snapshots', () => {
  it('keeps one source across chat/page/task while retaining distinct full run material', async () => {
    const captures = await Promise.all(
      (['chat', 'page', 'task'] as const).map((flavor) => captureOperationHarness(input(flavor))),
    );
    expect(new Set(captures.map((pinned) => pinned.revision.id)).size).toBe(1);
    expect(new Set(captures.map((pinned) => pinned.snapshot!.id)).size).toBe(3);
    for (const [index, flavor] of (['chat', 'page', 'task'] as const).entries()) {
      const pinned = captures[index];
      expect(pinned.revision.schemaVersion).toBe(2);
      expect(JSON.stringify(pinned.revision)).not.toContain('private');
      expect(JSON.stringify(pinned.revision)).not.toContain(`${flavor}-tool`);
      expect(JSON.stringify(pinned.snapshot)).toContain(`private-${flavor}-topic`);
      expect(resolveHarnessMaterial(pinned).agentConfig).toEqual(input(flavor).agentConfig);
      await expect(verifyHarness(pinned, scope, `${flavor}-operation`)).resolves.toBeUndefined();
    }
  });

  it('keeps adoption across entry points and replaces only the author segment', async () => {
    const { coordinator, experiment } = await adopted();
    for (const flavor of ['page', 'task', 'chat'] as const) {
      const captured = await captureOperationHarness(input(flavor));
      const revision = await coordinator.registerSource(captured.revision);
      const bound = await bindOperationBehavior(captured, revision);
      const material = resolveHarnessMaterial(bound);
      expect(bound.revision.id).toBe(experiment.candidateId);
      expect((material.agentConfig as any).systemRole).toBe(
        composeHarnessPrompt(
          input(flavor).harnessSource!.promptSegments,
          'Candidate author instructions',
        ),
      );
      expect((material.agentConfig as any).plugins).toEqual(input(flavor).agentConfig.plugins);
      expect(material.toolCatalog).toEqual(captured.snapshot!.material.toolCatalog);
      expect(material.operationSkillSet).toEqual(input(flavor).operationSkillSet);
      expect((await coordinator.store.read(scope)).active?.revisionId).toBe(experiment.candidateId);
    }
  });

  it.each(['model', 'provider'] as const)(
    'treats a per-call %s override as a local incompatibility without clearing adoption',
    async (key) => {
      const { coordinator, experiment, captured: original } = await adopted();
      const request = input('task');
      request.agentConfig[key] = `override-${key}`;
      request.modelRuntimeConfig[key] = `override-${key}`;
      const captured = await captureOperationHarness(request);
      expect(captured.revision.id).toBe(original.revision.id);
      const active = await coordinator.registerSource(captured.revision);
      const bound = await bindOperationBehavior(captured, active);
      expect(bound.revision.id).toBe(original.revision.id);
      expect(resolveHarnessMaterial(bound).modelRuntimeConfig).toEqual(request.modelRuntimeConfig);
      expect((await coordinator.store.read(scope)).active?.revisionId).toBe(experiment.candidateId);
      const next = await captureOperationHarness(input());
      expect((await coordinator.registerSource(next.revision)).id).toBe(experiment.candidateId);
    },
  );

  it('invalidates an incompatible adoption on author edits and keeps an already bound run unchanged', async () => {
    const { coordinator } = await adopted();
    const old = await captureOperationHarness(input('page'));
    const bound = await bindOperationBehavior(old, await coordinator.registerSource(old.revision));
    const changed = input('page');
    changed.harnessSource!.agentConfig.systemRole = 'Concurrent user edit';
    changed.harnessSource!.promptSegments[0].content = 'Concurrent user edit';
    changed.agentConfig.systemRole = composeHarnessPrompt(changed.harnessSource!.promptSegments);
    await coordinator.registerSource((await captureOperationHarness(changed)).revision);
    expect((await coordinator.store.read(scope)).active).toBeUndefined();
    const state: any = {
      metadata: { harness: JSON.parse(JSON.stringify(bound)), agentId: scope.agentId },
      operationToolSet: { executorMap: 'live-authorized-handle' },
    };
    await restoreOperationHarness(state, 'page-operation', scope.userId);
    expect(state.metadata.agentConfig.systemRole).toContain('Candidate author instructions');
    expect(state.metadata.agentConfig.systemRole).toContain('page host constraints');
    expect(state.metadata.agentConfig.systemRole).toContain('private page request');
    expect(state.operationToolSet.executorMap).toBe('live-authorized-handle');
    expect(state.metadata.harnessSnapshotId).toBe(bound.snapshot!.id);
  });

  it.each(['document', 'skill'] as const)(
    'changes behavior identity when %s material changes',
    async (kind) => {
      const first = await captureOperationHarness(input());
      const changed = input();
      if (kind === 'document')
        changed.agentDocuments = [{ id: 'doc', content: 'New document body' }];
      else changed.operationSkillSet!.skills[0].content = 'New full skill';
      expect((await captureOperationHarness(changed)).revision.id).not.toBe(first.revision.id);
    },
  );

  it('protects host fallback instructions when an empty authored role receives a candidate', async () => {
    const request = input();
    request.harnessSource!.agentConfig.systemRole = '';
    request.harnessSource!.promptSegments = [
      { kind: 'author', content: '' },
      { kind: 'host', content: 'Builtin host constraints' },
    ];
    request.agentConfig.systemRole = 'Builtin host constraints';
    const captured = await captureOperationHarness(request);
    const candidate = await applyHarnessPatch(captured.revision, {
      baseRevisionId: captured.revision.id,
      surface: 'chat.systemRole',
      value: 'Candidate role',
    });
    const bound = await bindOperationBehavior(captured, candidate);
    expect((resolveHarnessMaterial(bound).agentConfig as any).systemRole).toBe(
      'Candidate role\n\nBuiltin host constraints',
    );
  });

  it('rejects missing/tampered run snapshots and crossed operation bindings', async () => {
    const pinned = await captureOperationHarness(input('page'));
    await expect(
      verifyHarness({ ...pinned, snapshot: undefined }, scope, 'page-operation'),
    ).rejects.toThrow('HARNESS_SNAPSHOT_MISSING');
    const changed = JSON.parse(JSON.stringify(pinned));
    changed.snapshot.material.promptSegments[1].content = 'Tampered host';
    await expect(verifyHarness(changed, scope, 'page-operation')).rejects.toThrow(
      'HARNESS_SNAPSHOT_CORRUPT',
    );
    const credential = JSON.parse(JSON.stringify(pinned));
    credential.snapshot.material.agentConfig.apiKey = 'injected-credential';
    await expect(verifyHarness(credential, scope, 'page-operation')).rejects.toThrow(
      'HARNESS_SNAPSHOT_CORRUPT',
    );
    await expect(verifyHarness(pinned, scope, 'different-operation')).rejects.toThrow(
      'HARNESS_BINDING_MISMATCH',
    );
    await expect(
      verifyHarness(pinned, { ...scope, userId: 'other' }, 'page-operation'),
    ).rejects.toThrow('HARNESS_BINDING_MISMATCH');
  });

  it('rejects a composed prompt that no longer agrees with host-produced provenance', async () => {
    const request = input('page');
    request.agentConfig.systemRole = 'Untracked replacement';
    await expect(captureOperationHarness(request)).rejects.toThrow(
      'HARNESS_SOURCE_PROVENANCE_MISMATCH',
    );
  });

  it('probes v2 behavior with actual context compilation, neutral inputs and isolated selection', async () => {
    const request = input('page');
    request.agentDocuments = [
      {
        id: 'doc',
        filename: 'AGENTS.md',
        title: 'Instructions',
        content: 'PRIVATE_AGENT_DOCUMENT',
        policyLoad: 'always',
      },
    ];
    const captured = await captureOperationHarness(request);
    const candidate = await applyHarnessPatch(captured.revision, {
      baseRevisionId: captured.revision.id,
      surface: 'chat.systemRole',
      value: 'Candidate instructions for text tasks',
    });
    const requests: any[] = [];
    const probe = createChatProbePort({
      model: 'model',
      provider: 'provider',
      runtime: {
        chat: async (payload, options) => {
          requests.push(payload);
          await options?.callback?.onText?.('Fixture answer');
          return new Response('');
        },
      },
    });
    const run = { maxTokens: 128, signal: new AbortController().signal };
    await probe.complete({
      ...run,
      revision: candidate,
      system: 'Uncompiled author',
      prompt: 'New task',
    });
    expect(JSON.stringify(requests[0].messages)).toContain('Candidate instructions for text tasks');
    expect(JSON.stringify(requests[0].messages)).toContain('PRIVATE_AGENT_DOCUMENT');
    expect(JSON.stringify(requests[0].messages)).not.toContain('private page request');
    expect(JSON.stringify(requests[0].messages)).not.toContain('page host constraints');
    expect(requests[0]).toMatchObject({ model: 'model', tools: [], max_tokens: 128 });
    await probe.complete({
      ...run,
      revision: candidate,
      purpose: 'selection',
      system: 'Compare',
      prompt: 'Answer data',
    });
    expect(JSON.stringify(requests[1].messages)).not.toContain('PRIVATE_AGENT_DOCUMENT');
    expect(JSON.stringify(requests[1].messages)).not.toContain('Candidate instructions');
    const incompatible = await captureOperationHarness({
      ...request,
      harnessSource: {
        ...request.harnessSource!,
        agentConfig: { ...request.harnessSource!.agentConfig, model: 'another-model' },
      },
    });
    await expect(
      probe.complete({ ...run, revision: incompatible.revision, system: '', prompt: 'New task' }),
    ).rejects.toThrow('HARNESS_PROBE_MODEL_MISMATCH');
    expect(requests).toHaveLength(2);
  });
});
