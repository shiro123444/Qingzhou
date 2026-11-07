import type { HarnessRevision, HarnessScope, SkillMaterialReceipt } from '@lobechat/agent-runtime';

import type { LearningCapture } from './learning-commands';

export class LearningWritePendingError extends Error {
  constructor(readonly intentId: string) {
    super(`HARNESS_VALIDATION_REQUIRED:${intentId}`);
  }
}

export interface ExperimentTask {
  id: string;
  prompt: string;
}

/** An exclusive scope lease with durable intermediate saves, not a database transaction
 * held over model calls. Cancellation remains independently writable.
 */
export interface HarnessStore {
  cancel: (scope: HarnessScope, experimentId: string) => Promise<void>;
  cancelled: (scope: HarnessScope, experimentId: string) => Promise<boolean>;
  read: (scope: HarnessScope) => Promise<HarnessScopeState>;
  transaction: <T>(
    scope: HarnessScope,
    run: (state: HarnessScopeState, save: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
}
export interface ExperimentBudget {
  calls: number;
  costMicros: number;
  costMicrosPerCall: number;
  deadlineMs: number;
  inputBytesPerCall: number;
  outputTokensPerCall: number;
  tokens: number;
}
export interface ModelReceipt {
  context?: unknown;
  costMicros?: number;
  inputTokens?: number;
  materialReceipt?: SkillMaterialReceipt;
  outputTokens?: number;
  text: string;
}
export interface ExperimentPort {
  /** All model work, including the selector, goes through the same charged port. No tools. */
  complete: (input: {
    system: string;
    prompt: string;
    maxTokens: number;
    maxInputBytes?: number;
    purpose?: 'answer' | 'selection';
    /** Trusted coordinator supplies the complete version being probed. */
    revision?: HarnessRevision;
    signal: AbortSignal;
  }) => Promise<ModelReceipt>;
}
export interface HarnessPatch {
  baseRevisionId: string;
  surface:
    | 'chat.systemRole'
    | 'chat.contextStrategy'
    | 'managed.skillBody'
    | 'context.skillMaterial';
  targetBindingId?: string;
  value: string;
}
/** AgentSignal may propose from visible evidence; this port cannot spend experiment budgets or adopt. */
export interface HarnessProposalPort {
  propose: (input: {
    baselineId: string;
    systemRole: string;
    rationale: string;
    evidenceIds: string[];
  }) => Promise<{ id: string; status: 'proposed' }>;
  readSource: () => Promise<{ baselineId: string; systemRole: string } | undefined>;
}
export interface ExperimentAttempt {
  chargedCostMicros: number;
  chargedTokens: number;
  costBasis: 'reserved' | 'measured';
  error?: string;
  inputBytes: number;
  label: string;
  receipt?: ModelReceipt;
  reservedOutputTokens: number;
  status: 'reserved' | 'completed' | 'failed' | 'cancelled';
}
export interface ExperimentComparison {
  choice: 'baseline' | 'candidate' | 'unknown';
  /** Anonymous IDs are revealed only in the private evidence, never in selector input. */
  order: ('baseline' | 'candidate')[];
  rationale: string;
  taskId: string;
}
export interface HarnessExperiment {
  createdAt?: string;
  attempts: ExperimentAttempt[];
  baselineId: string;
  budget: ExperimentBudget;
  /** Parent identity is derived from the owned experiment; bindings stay server-side. */
  budgetRootId?: string;
  candidateId: string;
  comparisons: ExperimentComparison[];
  error?: string;
  heldout: ExperimentTask[];
  id: string;
  patch: HarnessPatch;
  status: 'registered' | 'running' | 'completed' | 'failed' | 'cancelled';
  tasks: ExperimentTask[];
  validation: 'pending' | 'passed' | 'rejected' | 'unknown';
  validationBudget?: ExperimentBudget;
  validationComparisons: ExperimentComparison[];
}
export interface LearningEpisodeEnvelope {
  applicability: string;
  baselineRevisionId?: string;
  candidateRevisionId?: string;
  /** References are private, immutable full bundles; a lesson does not replace them. */
  configurationRefs: string[];
  domain: string;
  evidenceRef: string;
  id: string;
  outcome: 'candidate' | 'baseline' | 'failed' | 'cancelled' | 'unknown';
  schemaVersion: 1;
  scope: HarnessScope;
  /** A local artifact choice is distinct from activating shared agent behavior. */
  selection?: {
    action: 'adopt' | 'keep';
    subject: 'artifact' | 'harness';
    selectedRevisionId?: string;
    sourceVersionId?: string;
    resultVersionId?: string;
    requestId: string;
    reason?: string;
  };
  validation: 'pending' | 'passed' | 'rejected' | 'unknown';
}
export interface HarnessDecision {
  action: 'adopt' | 'keep' | 'rollback';
  at: string;
  experimentId?: string;
  id: string;
  previousId?: string;
  reason?: string;
  revisionId?: string;
}
export interface HarnessScopeState {
  active?: { revisionId: string; sourceRevisionId: string };
  decisions: HarnessDecision[];
  episodes: LearningEpisodeEnvelope[];
  experiments: Record<string, HarnessExperiment>;
  instructionProposals?: {
    id: string;
    sourceId: string;
    baselineId: string;
    systemRole: string;
    rationale: string;
    evidence: unknown;
    at: string;
  }[];
  intents?: {
    id: string;
    domain: 'managed-skill';
    operation: string;
    material: unknown;
    status: 'pending-validation';
    at: string;
  }[];
  learning?: LearningCapture[];
  revisions: Record<string, HarnessRevision>;
  schemaVersion: 1;
  scope: HarnessScope;
  sourceRevisionId?: string;
}
