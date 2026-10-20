import { Tag } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresentationJobState } from '../../../packages/runtime-contracts/src/index';

export interface JobStateTagProps {
  state: PresentationJobState;
}

export const JOB_STATE_COLORS: Record<
  PresentationJobState,
  'default' | 'processing' | 'success' | 'error'
> = {
  cancelled: 'default',
  completed: 'success',
  failed: 'error',
  queued: 'default',
  running: 'processing',
  waiting_input: 'default',
};

const JOB_STATE_LABELS: Record<PresentationJobState, string> = {
  cancelled: 'cancelled',
  completed: 'completed',
  failed: 'failed',
  queued: 'queued',
  running: 'running',
  waiting_input: '待你决定',
};

export const JobStateTag = memo<JobStateTagProps>(({ state }) => {
  const { t } = useTranslation('common');
  return (
    <Tag color={JOB_STATE_COLORS[state]}>
      {state === 'waiting_input' ? t('presentationCollaboration.pending') : JOB_STATE_LABELS[state]}
    </Tag>
  );
});

JobStateTag.displayName = 'JobStateTag';

export default JobStateTag;
