/** Domain identities are data, never fabricated Agent IDs. */
export type LearningSubject =
  | { kind: 'agent'; agentId: string }
  | { kind: 'presentation'; jobId: string; sessionId: string };
export interface LearningScope {
  subject: LearningSubject;
  userId: string;
}
export interface LearningUsage {
  calls: number;
  costMicros: number;
  tokens: number;
}
export interface LearningBudgetRef {
  childId: string;
  rootId: string;
  scope: LearningScope;
}
export interface LearningEpisodeV2 {
  applicability: string;
  baselineRevisionId?: string;
  budgetRef?: LearningBudgetRef;
  candidateRevisionId?: string;
  configurationRefs: string[];
  domain: string;
  evidenceRef: string;
  id: string;
  outcome: 'candidate' | 'baseline' | 'failed' | 'cancelled' | 'unknown';
  schemaVersion: 2;
  scope: LearningScope;
  selection?: {
    action: 'adopt' | 'keep';
    type: 'behavior-activation' | 'artifact-fork';
    requestId: string;
    selectedRevisionId?: string;
    sourceVersionId?: string;
    resultVersionId?: string;
    reason?: string;
  };
  validation: 'pending' | 'passed' | 'rejected' | 'unknown';
}
