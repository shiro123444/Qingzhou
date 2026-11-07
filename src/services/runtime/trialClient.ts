import type {
  LearningEpisodeView,
  TrialReviewChoice,
  TrialReviewResult,
  TrialReviewView,
  TrialStartInput,
  TrialWorkspaceStatus,
} from '@/types/presentationTrial';
import type {
  TrialValidationView,
  ValidationTarget,
  ValidationTargetOption,
} from '@/types/presentationValidation';

export class TrialRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
async function call<T>(
  operation: string,
  input: unknown,
  signal?: AbortSignal,
  domain = 'trial',
): Promise<T> {
  const response = await fetch(
    `/api/runtime/presentation/tools/presentation.${domain}.${operation}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new TrialRequestError(body?.error?.code ?? 'PRESENTATION_TRIAL_FAILED', response.status);
  return body as T;
}
export const presentationTrialClient = {
  start: (input: TrialStartInput, signal?: AbortSignal) =>
    call<TrialWorkspaceStatus>('start', input, signal),
  status: (jobId: string, slideId: string, signal?: AbortSignal) =>
    call<TrialWorkspaceStatus>('status', { jobId, slideId }, signal),
  cancel: (executionId: string, signal?: AbortSignal) =>
    call<TrialWorkspaceStatus>('cancel', { executionId }, signal),
  list: (jobId: string, slideId: string, signal?: AbortSignal) =>
    call<{ trials: { runId: string }[] }>('list', { jobId, slideId }, signal),
  read: (runId: string, signal?: AbortSignal) => call<TrialReviewView>('read', { runId }, signal),
  choose: (choice: TrialReviewChoice, signal?: AbortSignal) =>
    call<TrialReviewResult>('choose', choice, signal),
};

export const presentationLearningClient = {
  list: (jobId: string, slideId: string, signal?: AbortSignal) =>
    learningCall<{
      episodes: Pick<LearningEpisodeView, 'episodeId' | 'kind' | 'status' | 'outcome'>[];
    }>('list', { jobId, slideId }, signal),
  read: (episodeId: string, signal?: AbortSignal) =>
    learningCall<LearningEpisodeView>('read', { episodeId }, signal),
};
async function learningCall<T>(
  operation: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return call<T>(operation, input, signal, 'learning');
}

export const presentationValidationClient = {
  options: (episodeId: string, signal?: AbortSignal) =>
    call<{
      targets: ValidationTargetOption[];
      validations: { validationId: string }[];
    }>('options', { episodeId }, signal, 'validation'),
  create: (
    input: {
      episodeId: string;
      requestId: string;
      targets: ValidationTarget[];
      confirmed: true;
    },
    signal?: AbortSignal,
  ) => call<TrialValidationView>('create', input, signal, 'validation'),
  start: (validationId: string, signal?: AbortSignal) =>
    call<TrialValidationView>('start', { validationId, confirmed: true }, signal, 'validation'),
  status: (validationId: string, signal?: AbortSignal) =>
    call<TrialValidationView>('status', { validationId }, signal, 'validation'),
  cancel: (validationId: string, signal?: AbortSignal) =>
    call<TrialValidationView>('cancel', { validationId }, signal, 'validation'),
};
