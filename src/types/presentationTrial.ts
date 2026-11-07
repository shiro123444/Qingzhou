export interface TrialReviewView {
  evidenceDigest: string;
  improvement?: {
    rounds: number;
    selectedRound: number;
    charged: { tokens: number; costMicros: number };
    refinementFailed: boolean;
  };
  proposal?: {
    dimension: 'layoutStrategy' | 'textSpacing' | 'compositionRecipe';
    value: string;
    rationale: string;
    experienceCount: number;
  };
  recommendedId: string;
  runId: string;
  source: { jobId: string; versionId: string; slideId: string };
  variants: {
    id: string;
    selectable: boolean;
    previewUri?: string;
    gates?: Record<string, { status: 'passed' | 'failed' | 'unknown'; evidence: string }>;
    quality?: Record<string, { score: number; evidence: string }>;
  }[];
}
export interface TrialReviewChoice {
  confirmed: true;
  evidenceDigest: string;
  expectedVersionId: string;
  jobId: string;
  reason?: string;
  requestId: string;
  runId: string;
  variantId: string;
}
export interface TrialReviewResult {
  jobId: string;
  learningEpisodeId?: string;
  learningStatus?: 'recorded' | 'pending';
  status: 'kept' | 'created';
  versionId: string;
}

export interface TrialStartInput {
  confirmed: true;
  expectedVersionId: string;
  jobId: string;
  mode?: 'serial';
  requestId: string;
  slideId: string;
}
export interface TrialExecution {
  charged?: { tokens: number; costMicros: number };
  errorCode?: string;
  executionId: string;
  learningEpisodeId?: string;
  learningStatus?: 'recorded' | 'pending';
  mode?: 'serial';
  phase: 'preparing' | 'propose' | 'probe' | 'render' | 'evaluate' | 'finalizing';
  requestId: string;
  round?: 1 | 2;
  runId?: string;
  source: { jobId: string; versionId: string; slideId: string };
  startedAt: string;
  state:
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'budget-exceeded'
    | 'deadline-exceeded'
    | 'interrupted';
  updatedAt: string;
}
export interface TrialWorkspaceStatus {
  budget: {
    maxProbes: number;
    maxRenders: number;
    maxEvaluations: number;
    maxProposals?: number;
    maxTokens: number;
    maxCostMicros: number;
    maxDurationMs: number;
  };
  execution?: TrialExecution;
  serialBudget?: TrialWorkspaceStatus['budget'];
  singleBudget?: TrialWorkspaceStatus['budget'];
}

export interface LearningEpisodeView {
  cue: {
    domain: 'presentation';
    title?: string;
    aspectRatio?: string;
    pageRole?: string;
    slideNumber?: number;
  };
  episodeId: string;
  executionId?: string;
  failureCode?: string;
  kind: 'attempt' | 'decision';
  lesson: { applicability: 'source-page-only'; observation: string; transfer: 'unverified' };
  outcome: string;
  reason?: string;
  reasonProvided: boolean;
  result?: { jobId: string; versionId: string; status: 'created' | 'kept' };
  runId?: string;
  selectedVariantId?: string;
  source: { jobId: string; versionId: string; slideId: string };
  status: 'pending-validation';
  variants: {
    id: string;
    configurationDigest?: string;
    configurationCompared: boolean;
    changedPaths: string[];
    pageChanged?: boolean;
    notesChanged?: boolean;
    previewUri?: string;
    gates?: TrialReviewView['variants'][number]['gates'];
    quality?: TrialReviewView['variants'][number]['quality'];
    available: { configuration: boolean; plan: boolean; preview: boolean; evaluation: boolean };
  }[];
}
