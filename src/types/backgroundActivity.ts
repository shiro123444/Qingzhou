export const ACTIVITY_FILTERS = [
  'all',
  'active',
  'waiting',
  'attention',
  'reviewed',
  'finished',
] as const;
export const REVIEW_DECISIONS = ['effect_confirmed', 'no_effect', 'closed'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export interface ActivityReview {
  decision: ReviewDecision;
  evidence: string;
  reviewedAt: string;
}
export interface ActivityReviewInput {
  category: ActivityCategory;
  decision: ReviewDecision;
  evidence: string;
  id: string;
  incidentToken: string;
}
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];
export type ActivityCategory = 'agent' | 'wake';
export type ActivityStatus =
  'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type ActivityKind =
  | 'conversation'
  | 'heartbeat'
  | 'schedule'
  | 'selfImprovement'
  | 'taskUpdate'
  | 'threadUpdate'
  | 'event';

export interface ActivityCursor {
  category: ActivityCategory;
  createdAt: string;
  id: string;
}
export interface ActivityItem extends ActivityCursor {
  agentId?: string;
  agentTitle?: string;
  attempts: number;
  canStop: boolean;
  hasReviewHistory?: boolean;
  incidentToken?: string;
  kind: ActivityKind;
  nextRunAt?: string;
  review?: ActivityReview;
  status: ActivityStatus;
  stepCount?: number;
  taskId?: string;
  taskTitle?: string;
  threadId?: string;
  title?: string;
  topicId?: string;
  updatedAt: string;
}
export interface ActivityListInput {
  cursor?: ActivityCursor;
  filter?: ActivityFilter;
  limit?: number;
}
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor?: ActivityCursor;
}

export type WorkerKind = 'agent' | 'wake';
export type WorkerPhase = 'idle' | 'busy' | 'degraded' | 'stopping' | 'stopped';
export interface WorkerHealth {
  consecutiveFailures: number;
  degradedInstances: number;
  healthyInstances: number;
  heartbeatAt?: string;
  kind: WorkerKind;
  lastFailureAt?: string;
  lastPollAt?: string;
  lastSuccessAt?: string;
  status: 'online' | 'busy' | 'degraded' | 'stopping' | 'stopped' | 'unresponsive' | 'unobserved';
}
export interface QueueHealth {
  expiredLeases: number;
  oldestReadyAgeSeconds: number;
  quarantined: number;
  ready: number;
  running: number;
  scheduled: number;
}
export interface ActivityHealth {
  checkedAt: string;
  queue: QueueHealth;
  workers: WorkerHealth[];
}
