import {
  harnessDigest,
  type HarnessPublicationRef,
  type HarnessRevision,
  type HarnessScope,
  verifyHarnessRevision,
} from '@lobechat/agent-runtime';

import type {
  HarnessDecision,
  HarnessExperiment,
  HarnessStore,
  LearningEpisodeEnvelope,
} from './contracts';
import { applyHarnessPatch } from './coordinator';
import type { LearningCapture } from './learning-commands';
import type { MutationAuthority } from './mutation-authority';

/** Provider contract: publication is atomic; external work is dispatched only after commit. */
export interface HarnessPublicationPort {
  cancel: (
    scope: HarnessScope,
    experimentId: string,
    authority: MutationAuthority,
  ) => Promise<void>;
  commit: (
    scope: HarnessScope,
    command: PublicationCommand,
    authority: MutationAuthority,
    proof?: PublicationProof,
  ) => Promise<PublicationDecision>;
  currentSource: (scope: HarnessScope) => Promise<HarnessRevision>;
  decisions: (scope: HarnessScope) => Promise<PublicationDecision[]>;
  flushOutbox: (
    scope: HarnessScope,
    deliver: (event: PublicationEvent) => Promise<void>,
  ) => Promise<void>;
  read: (scope: HarnessScope) => Promise<PublicationHead>;
  replay: (
    scope: HarnessScope,
    command: PublicationCommand,
    authority: MutationAuthority,
  ) => Promise<PublicationDecision | undefined>;
  resolve: (source: HarnessRevision) => Promise<HarnessRevision>;
  selection: (source: HarnessRevision) => Promise<HarnessSelection>;
}

export interface PublicationHead {
  active?: HarnessRevision;
  cancelledExperiments: string[];
  decisionId?: string;
  generation: number;
  source?: HarnessRevision;
}
export interface HarnessSelection {
  publicationRef?: HarnessPublicationRef;
  revision: HarnessRevision;
}
export interface PublicationCommand {
  action: 'adopt' | 'keep' | 'rollback';
  candidateId?: string;
  expectedActiveId?: string;
  expectedGeneration: number;
  expectedSourceGeneration?: number;
  expectedSourceId?: string;
  experimentId?: string;
  id: string;
  reason?: string;
  validationDigest?: string;
}
export interface PublicationProof {
  baseline: HarnessRevision;
  candidate: HarnessRevision;
  experiment: HarnessExperiment;
  validationDigest: string;
}
export interface PublicationEvent {
  action: PublicationCommand['action'];
  generation: number;
  id: string;
  revisionId?: string;
  scope: HarnessScope;
}
export type PublicationDecision = HarnessDecision & {
  learning?: LearningCapture;
  episode?: LearningEpisodeEnvelope;
  generation: number;
};

export const validationDigest = (experiment: HarnessExperiment) => harnessDigest(experiment);

export async function assertPublicationProof(
  scope: HarnessScope,
  command: PublicationCommand,
  proof: PublicationProof,
): Promise<void> {
  const { baseline, candidate, experiment } = proof;
  await verifyHarnessRevision(baseline, scope);
  await verifyHarnessRevision(candidate, scope);
  if (baseline.schemaVersion !== 2 || baseline.material.configurationComplete !== true)
    throw new Error('HARNESS_SOURCE_RECAPTURE_REQUIRED');
  if (
    command.experimentId !== experiment.id ||
    command.candidateId !== candidate.id ||
    command.expectedSourceId !== baseline.id ||
    command.expectedSourceGeneration !==
      ((baseline.material.agentConfig as { generation?: number }).generation ?? 0) ||
    experiment.baselineId !== baseline.id ||
    experiment.candidateId !== candidate.id ||
    (await applyHarnessPatch(baseline, experiment.patch)).id !== candidate.id
  )
    throw new Error('HARNESS_STALE_SOURCE');
  const digest = await validationDigest(experiment);
  if (digest !== proof.validationDigest || digest !== command.validationDigest)
    throw new Error('HARNESS_STALE_VALIDATION');
  if (experiment.status !== 'completed') throw new Error('HARNESS_EXPERIMENT_INCOMPLETE');
  if (
    command.action === 'adopt' &&
    (experiment.validation !== 'passed' ||
      experiment.comparisons.length !== experiment.tasks.length ||
      experiment.validationComparisons.length !== experiment.heldout.length ||
      ![...experiment.comparisons, ...experiment.validationComparisons].every(
        (comparison) => comparison.choice === 'candidate',
      ))
  )
    throw new Error('HARNESS_NOT_VALIDATED');
}

/** Copy the complete proof before entering the short publication transaction. */
export async function preparePublication(
  store: HarnessStore,
  scope: HarnessScope,
  command: PublicationCommand,
): Promise<PublicationProof> {
  const state = await store.read(scope);
  const experiment = command.experimentId && state.experiments[command.experimentId];
  if (!experiment) throw new Error('HARNESS_EXPERIMENT_NOT_FOUND');
  if (state.sourceRevisionId !== experiment.baselineId) throw new Error('HARNESS_STALE_SOURCE');
  if (await store.cancelled(scope, experiment.id)) throw new Error('HARNESS_CANCELLED');
  const baseline = state.revisions[experiment.baselineId];
  const candidate = state.revisions[experiment.candidateId];
  if (!baseline || !candidate) throw new Error('HARNESS_REVISION_MISSING');
  const proof = structuredClone({
    baseline,
    candidate,
    experiment,
    validationDigest: await validationDigest(experiment),
  });
  await assertPublicationProof(scope, command, proof);
  return proof;
}
