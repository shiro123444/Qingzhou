export interface ValidationTarget {
  expectedVersionId: string;
  jobId: string;
  slideId: string;
}
export interface ValidationTargetOption extends ValidationTarget {
  pageNumber: number;
  title: string;
}
export interface TrialValidationView {
  automaticPromotion: false;
  budget: {
    maxTokens: number;
    maxCostMicros: number;
    maxDurationMs: number;
    maxProbes: number;
    maxRenders: number;
    maxEvaluations: number;
  };
  charged: { tokens: number; costMicros: number };
  episodeId: string;
  manifestDigest: string;
  state:
    | 'prepared'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'deadline-exceeded'
    | 'interrupted';
  targets: (ValidationTargetOption & {
    errorCode?: string;
    outcome: 'not-started' | 'running' | 'improved' | 'tied' | 'regressed' | 'incomplete';
    runId?: string;
  })[];
  validationId: string;
  verdict: 'pending' | 'review-ready' | 'no-improvement' | 'regressed' | 'insufficient-evidence';
}
