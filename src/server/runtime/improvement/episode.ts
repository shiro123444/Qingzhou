import {
  createHarnessRevision,
  type HarnessRevision,
  type HarnessScope,
} from '@lobechat/agent-runtime';

import type { LearningEpisodeEnvelope } from './contracts';

/** A domain keeps its full evidence archive; the shared protocol indexes immutable configuration versions. */
export async function captureLearningEpisode(input: {
  id: string;
  domain: string;
  scope: HarnessScope;
  evidenceRef: string;
  configurations: Record<string, unknown>[];
  baselineIndex?: number;
  candidateIndex?: number;
  selection?: Omit<NonNullable<LearningEpisodeEnvelope['selection']>, 'selectedRevisionId'> & {
    selectedIndex: number;
  };
  outcome: LearningEpisodeEnvelope['outcome'];
  applicability: string;
}) {
  const revisions: HarnessRevision[] = [];
  for (const material of input.configurations)
    revisions.push(await createHarnessRevision(input.scope, material));
  const episode: LearningEpisodeEnvelope = {
    schemaVersion: 1,
    id: input.id,
    domain: input.domain,
    scope: { ...input.scope },
    evidenceRef: input.evidenceRef,
    baselineRevisionId: revisions[input.baselineIndex ?? 0]?.id,
    candidateRevisionId: revisions[input.candidateIndex ?? 1]?.id,
    configurationRefs: revisions.map((revision) => revision.id),
    outcome: input.outcome,
    validation: 'pending',
    applicability: input.applicability,
  };
  if (input.selection) {
    const { selectedIndex, ...selection } = input.selection;
    episode.selection = { ...selection, selectedRevisionId: revisions[selectedIndex]?.id };
  }
  return { episode, revisions };
}
