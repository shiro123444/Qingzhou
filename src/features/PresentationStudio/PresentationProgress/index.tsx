import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Alert, Progress, Spin, Steps } from 'antd';
import { RefreshCw, Square } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import JobStateTag from '../JobStateTag';
import type { PresentationStreamStatus } from '../store/presentationStore';
import { styles } from './style';

export interface PresentationProgressProps {
  busyState?: 'cancel' | 'retry' | null;
  className?: string;
  job?: PresentationJob | null;
  onCancel?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
  /** Per-job live stream status (C-66); this job's status, never a sibling's. */
  streamStatus?: PresentationStreamStatus;
  title?: string;
}

const PIPELINE_STEPS = [
  { title: '大纲规划' },
  { title: '生成幻灯片' },
  { title: '质量校验' },
  { title: '导出 PPTX' },
];

const JobError = memo<{ code: string; message: string }>(({ code, message }) => (
  <div className={styles.errorBox} data-testid="presentation-job-error">
    <Alert showIcon description={message} message={`任务错误: ${code}`} role="alert" type="error" />
  </div>
));

JobError.displayName = 'JobError';

export const PresentationProgress = memo<PresentationProgressProps>(
  ({ busyState = null, className, job, onCancel, onRetry, streamStatus = null, title }) => {
    const { t } = useTranslation('common');
    const handleCancel = useCallback(() => {
      if (job?.jobId && onCancel) onCancel(job.jobId);
    }, [job?.jobId, onCancel]);

    const handleRetry = useCallback(() => {
      if (job?.jobId && onRetry) onRetry(job.jobId);
    }, [job?.jobId, onRetry]);

    if (!job) return null;

    const queued = job.state === 'queued';
    const running = job.state === 'running';
    const failed = job.state === 'failed';
    const cancelled = job.state === 'cancelled';
    const completed = job.state === 'completed';

    const waiting = job.state === 'waiting_input';
    const showCancel = queued || running || waiting;
    const showRetry = failed || cancelled;
    const canCancel = showCancel && busyState !== 'cancel';
    const canRetry = showRetry && busyState !== 'retry';

    const stepCurrent = queued ? 0 : running ? 1 : 3;
    void streamStatus;

    return (
      <section
        aria-busy={queued || running}
        aria-label="Presentation job status"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="presentation-progress"
      >
        <div className={styles.header}>
          <Flexbox horizontal align="center" gap={8}>
            <span className={styles.title}>{title ?? '演示文稿任务'}</span>
            <span className={styles.jobId}>({job.jobId})</span>
            <JobStateTag state={job.state} />
          </Flexbox>
        </div>

        <div
          aria-live="polite"
          className={styles.statusLine}
          data-testid="presentation-progress-status"
          role="status"
        >
          {queued && (
            <Flexbox horizontal align="center" gap={8}>
              <Spin size="small" />
              <span>
                任务排队中…
                <span style={{ display: 'none' }}>Job queued</span>
              </span>
            </Flexbox>
          )}
          {running && (
            <Flexbox horizontal align="center" gap={8}>
              <Spin size="small" />
              <span>
                正在生成幻灯片…
                <span style={{ display: 'none' }}>Generating slides</span>
              </span>
            </Flexbox>
          )}
          {completed && (
            <Flexbox horizontal align="center" gap={8}>
              <Progress
                percent={100}
                showInfo={false}
                size="small"
                status="success"
                strokeWidth={6}
                style={{ maxWidth: 160, width: '100%' }}
              />
              <span>
                已完成，幻灯片与文件就绪
                <span style={{ display: 'none' }}>Completed</span>
              </span>
            </Flexbox>
          )}
          {cancelled && (
            <span>
              任务已终止
              <span style={{ display: 'none' }}>Cancelled</span>
            </span>
          )}
          {failed && (
            <span>
              生成失败，请查看错误详情
              <span style={{ display: 'none' }}>Failed</span>
            </span>
          )}
          {waiting && <span>{t('presentationCollaboration.waiting')}</span>}
        </div>

        {(queued || running || completed) && (
          <Steps
            current={stepCurrent}
            items={PIPELINE_STEPS}
            size="small"
            status={completed ? 'finish' : 'process'}
          />
        )}

        {failed && (
          <JobError
            code={job.error?.code ?? 'UNKNOWN'}
            message={job.error?.message ?? '任务执行异常，未返回详细错误信息。'}
          />
        )}

        <div className={styles.actions}>
          {showCancel && (
            <Button
              danger
              aria-label="Cancel presentation job"
              disabled={!canCancel}
              icon={<Icon icon={Square} size={12} />}
              loading={busyState === 'cancel'}
              size="small"
              onClick={handleCancel}
            >
              取消任务
            </Button>
          )}
          {showRetry && (
            <Button
              aria-label="Retry presentation job"
              disabled={!canRetry}
              icon={<Icon icon={RefreshCw} size={12} />}
              loading={busyState === 'retry'}
              size="small"
              onClick={handleRetry}
            >
              重新生成
            </Button>
          )}
        </div>
      </section>
    );
  },
);

PresentationProgress.displayName = 'PresentationProgress';

export default PresentationProgress;
