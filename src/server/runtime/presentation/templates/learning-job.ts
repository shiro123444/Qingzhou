import type { PresentationLearningStatus } from '@/types/presentationLearning';

import type {
  TemplateMediaAnalysis,
  TemplateRenderedPage,
  TemplateVisualAnalysis,
} from './visual-types';

export interface TemplateLearningInput {
  choiceId?: string;
  guidance?: string;
  pages?: number[];
  questionId?: string;
  refresh?: boolean;
  templateId: string;
  versionId?: string;
}

export interface TemplateLearningJob extends PresentationLearningStatus {
  deadlineAt: string;
  input: TemplateLearningInput;
  inputKey: string;
  media?: TemplateMediaAnalysis[];
  observation?: { analysis: TemplateVisualAnalysis; pages: TemplateRenderedPage[] };
}

/** Do not expose source summaries or user answers in a progress/status response. */
export const learningStatus = (job: TemplateLearningJob): PresentationLearningStatus => {
  const {
    input: _input,
    inputKey: _key,
    deadlineAt: _deadline,
    media: _media,
    observation: _observation,
    ...status
  } = job;
  return status.state === 'running' && Date.parse(job.deadlineAt) <= Date.now()
    ? { ...status, state: 'interrupted' }
    : status;
};
