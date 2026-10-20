import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Popconfirm, Tooltip } from 'antd';
import { History, Layers, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import JobStateTag from '../JobStateTag';
import { styles } from './style';

export interface PresentationJobListProps {
  className?: string;
  jobs: PresentationJob[];
  onDelete?: (jobId: string) => Promise<void> | void;
  onSelect: (jobId: string) => void;
  selectedJobId: string | null;
  titles: Record<string, string>;
}

const shortId = (jobId: string): string => jobId.slice(0, 8);

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
};

export const PresentationJobList = memo<PresentationJobListProps>(
  ({ className, jobs, onDelete, onSelect, selectedJobId, titles }) => {
    const handleSelect = useCallback((jobId: string) => () => onSelect(jobId), [onSelect]);

    if (jobs.length === 0) {
      return (
        <section
          aria-label="Presentation job list"
          className={className ? `${styles.container} ${className}` : styles.container}
          data-testid="presentation-job-list"
        >
          <div className={styles.empty}>
            <Layers size={18} style={{ opacity: 0.4 }} />
            <span>
              暂无任务
              <span className={styles.srOnly}>No jobs yet</span>
            </span>
          </div>
        </section>
      );
    }

    return (
      <section
        aria-label="Presentation job list"
        aria-live="polite"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="presentation-job-list"
        role="listbox"
      >
        <Flexbox horizontal align="center" gap={8}>
          <History size={14} style={{ opacity: 0.6 }} />
          <span className={styles.title}>任务记录</span>
        </Flexbox>

        <ul className={styles.list}>
          {jobs.map((job) => {
            const isSelected = job.jobId === selectedJobId;
            const displayTitle = titles[job.jobId] ?? `Job ${shortId(job.jobId)}`;
            return (
              <li key={job.jobId}>
                <div className={styles.itemRow}>
                  <button
                    aria-label={`${titles[job.jobId] ? `Job ${displayTitle}` : displayTitle}, state: ${job.state}${isSelected ? ', selected' : ''}`}
                    aria-pressed={isSelected}
                    className={styles.item}
                    data-selected={isSelected ? 'true' : 'false'}
                    data-testid={`presentation-job-${job.jobId}`}
                    role="option"
                    tabIndex={0}
                    onClick={handleSelect(job.jobId)}
                  >
                    <Flexbox horizontal align="center" gap={8}>
                      <span
                        className={styles.itemTitle}
                        style={{ fontWeight: isSelected ? 600 : 500 }}
                      >
                        {displayTitle}
                      </span>
                      <JobStateTag state={job.state} />
                    </Flexbox>
                    <div className={styles.itemMeta}>
                      <span className={styles.itemId}>{shortId(job.jobId)}</span>
                      <span>更新于 {formatTime(job.updatedAt)}</span>
                    </div>
                  </button>
                  {onDelete && (
                    <Popconfirm
                      cancelText="取消"
                      description="该作品、页面与导出文件都会被永久删除。"
                      okButtonProps={{ danger: true }}
                      okText="删除"
                      title={`删除「${displayTitle}」？`}
                      onConfirm={() => onDelete(job.jobId)}
                    >
                      <Tooltip title="删除作品">
                        <Button
                          aria-label={`删除 ${displayTitle}`}
                          className={styles.deleteButton}
                          icon={<Icon aria-hidden icon={Trash2} size={16} />}
                          type="text"
                        />
                      </Tooltip>
                    </Popconfirm>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  },
);

PresentationJobList.displayName = 'PresentationJobList';

export default PresentationJobList;
