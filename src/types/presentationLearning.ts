/** Durable template learning progress, independent of a conversation turn. */
export interface PresentationLearningStatus {
  attempt: number;
  error?: { code: string; message: string };
  jobId: string;
  observedPages: number[];
  phase: 'render' | 'media' | 'observe' | 'compile';
  remainingPages: number[];
  state: 'running' | 'needs_input' | 'ready' | 'failed' | 'interrupted' | 'cancelled';
  templateId: string;
  totalPages: number;
  updatedAt: string;
  versionId: string;
}
