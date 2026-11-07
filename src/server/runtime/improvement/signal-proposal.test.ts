// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHarnessRevision } from '@lobechat/agent-runtime';
import { afterEach, expect, it, vi } from 'vitest';

import { HarnessCoordinator } from './coordinator';
import * as production from './production';
import { createSignalHarnessProposals } from './signal-proposal';
import { FileHarnessStore } from './store';

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('records source-bound reflection candidates with evidence, without models, active writes or heldout leakage', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qingzhou-signal-proposal-'));
  const coordinator = new HarnessCoordinator(new FileHarnessStore(root));
  vi.spyOn(production, 'withHarnessCoordinator').mockImplementation((run) => run(coordinator));
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '1');
  const scope = { userId: 'owner', agentId: 'agent' };
  const source = await createHarnessRevision(scope, {
    configurationComplete: true,
    agentConfig: { systemRole: 'original' },
    operationSkillSet: { private: 'PRIVATE_SKILL' },
  });
  await coordinator.registerSource(source);
  const evidence = vi.fn(async () => ({
    topics: [{ id: 'topic', summary: 'Repeated unsupported claims' }],
  }));
  const port = createSignalHarnessProposals({ scope, sourceId: 'reflection-source', evidence })!;
  expect(await port.readSource()).toEqual({ baselineId: source.id, systemRole: 'original' });
  const candidate = {
    baselineId: source.id,
    systemRole: 'original\nExplain evidence gaps.',
    rationale: 'Repeated unsupported claims',
    evidenceIds: ['topic'],
  };
  const proposed = await port.propose(candidate);
  expect(await port.propose(candidate)).toEqual(proposed);
  const stored = await coordinator.store.read(scope);
  expect(stored.instructionProposals).toHaveLength(1);
  expect(stored.instructionProposals![0]).toMatchObject({
    systemRole: candidate.systemRole,
    evidence: { topics: [{ id: 'topic' }] },
  });
  expect(stored.experiments).toEqual({});
  expect(stored.active).toBeUndefined();
  await expect(port.propose({ ...candidate, baselineId: 'stale' })).rejects.toThrow(
    'HARNESS_STALE_SOURCE',
  );
  await expect(port.propose({ ...candidate, evidenceIds: [] })).rejects.toThrow(
    'HARNESS_INVALID_EVIDENCE',
  );
  const other = createSignalHarnessProposals({
    scope: { ...scope, userId: 'other' },
    sourceId: 'reflection-source',
    evidence,
  })!;
  expect(await other.readSource()).toBeUndefined();
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
  expect(createSignalHarnessProposals({ scope, sourceId: 'source', evidence })).toBeUndefined();
  await expect(port.propose(candidate)).rejects.toThrow('HARNESS_DISABLED');
});
