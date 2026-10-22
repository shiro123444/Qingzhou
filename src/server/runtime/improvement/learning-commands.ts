import {
  harnessData,
  harnessDigest,
  type LearningBudgetRef,
  type LearningEpisodeV2,
  type LearningScope,
} from '@lobechat/agent-runtime';

export interface LearningCapture {
  configurations: { id: string; scope: LearningScope; material: ReturnType<typeof harnessData> }[];
  episode: LearningEpisodeV2;
}
/** Shared commands generate evidence identities. Domain stores retain their own publication semantics. */
export class LearningCommands {
  async capture(input: {
    type: 'observation' | 'behavior-activation' | 'artifact-fork';
    scope: LearningScope;
    id: string;
    domain: string;
    evidenceRef: string;
    configurations: Record<string, unknown>[];
    baselineIndex?: number;
    candidateIndex?: number;
    outcome: LearningEpisodeV2['outcome'];
    validation?: LearningEpisodeV2['validation'];
    applicability: string;
    budgetRef?: LearningBudgetRef;
    selection?: Omit<NonNullable<LearningEpisodeV2['selection']>, 'selectedRevisionId' | 'type'> & {
      selectedIndex: number;
    };
  }): Promise<LearningCapture> {
    if (
      !input.scope.userId?.trim() ||
      !input.id.trim() ||
      !input.evidenceRef.trim() ||
      (input.type === 'artifact-fork' && input.scope.subject.kind !== 'presentation') ||
      (input.type === 'behavior-activation' && input.scope.subject.kind !== 'agent') ||
      (input.type === 'observation' && input.selection) ||
      (input.type !== 'observation' && !input.selection)
    )
      throw new Error('LEARNING_COMMAND_INVALID');
    const scope = structuredClone(input.scope);
    if (
      scope.subject.kind === 'agent'
        ? !scope.subject.agentId?.trim()
        : scope.subject.kind === 'presentation'
          ? !scope.subject.jobId?.trim() || !scope.subject.sessionId?.trim()
          : true
    )
      throw new Error('LEARNING_COMMAND_INVALID');
    if (input.budgetRef && input.budgetRef.scope.userId !== scope.userId)
      throw new Error('LEARNING_COMMAND_INVALID');
    const configurations = [];
    for (const configuration of input.configurations) {
      const body = {
        schemaVersion: 2,
        scope,
        material: harnessData(configuration, true),
      };
      configurations.push({
        id: `learning-config-${await harnessDigest(body)}`,
        scope,
        material: body.material,
      });
    }
    const episode: LearningEpisodeV2 = {
      schemaVersion: 2,
      id: input.id,
      scope,
      domain: input.domain,
      evidenceRef: input.evidenceRef,
      configurationRefs: configurations.map((c) => c.id),
      baselineRevisionId: configurations[input.baselineIndex ?? 0]?.id,
      candidateRevisionId: configurations[input.candidateIndex ?? 1]?.id,
      outcome: input.outcome,
      validation: input.validation ?? 'pending',
      applicability: input.applicability,
      ...(input.budgetRef ? { budgetRef: structuredClone(input.budgetRef) } : {}),
    };
    if (input.selection) {
      const { selectedIndex, ...selection } = input.selection;
      if (!configurations[selectedIndex]) throw new Error('LEARNING_COMMAND_INVALID');
      episode.selection = {
        ...selection,
        type: input.type as 'behavior-activation' | 'artifact-fork',
        selectedRevisionId: configurations[selectedIndex].id,
      };
    }
    return { episode, configurations };
  }
}
