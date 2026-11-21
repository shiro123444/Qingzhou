import { Button, Drawer } from '@lobehub/ui';
import { Alert, Empty, Spin, Tag } from 'antd';
import { lazy, memo, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

import { aiAgentService } from '@/services/aiAgent';
import { backgroundActivityService } from '@/services/backgroundActivity';
import {
  ACTIVITY_FILTERS,
  type ActivityCursor,
  type ActivityFilter,
  type ActivityItem,
  type ActivityPage,
} from '@/types/backgroundActivity';

import HealthSummary from './HealthSummary';
import ReviewDialog from './ReviewDialog';
import { styles } from './style';

const ComputerPanel = lazy(() => import('@/features/AgentComputer'));

const colors = {
  cancelled: 'default',
  completed: 'success',
  failed: 'error',
  queued: 'default',
  running: 'processing',
  unknown: 'warning',
  waiting: 'warning',
} as const;

const ActivityPanel = memo<{ onClose: () => void; ownerId: string }>(({ onClose, ownerId }) => {
  const { t, i18n } = useTranslation('chat');
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [stopping, setStopping] = useState<string>();
  const [stopError, setStopError] = useState(false);
  const [reviewing, setReviewing] = useState<ActivityItem>();
  const [computerAgentId, setComputerAgentId] = useState<string>();
  const monitoring = useSWR(
    ['backgroundActivityHealth', ownerId],
    () => backgroundActivityService.health(),
    { refreshInterval: 5000, shouldRetryOnError: false },
  );
  const getKey = (
    _index: number,
    previous: ActivityPage | null,
  ): readonly ['backgroundActivity', string, ActivityFilter, ActivityCursor | undefined] | null =>
    previous && !previous.nextCursor
      ? null
      : ['backgroundActivity', ownerId, filter, previous?.nextCursor];
  const { data, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite<
    ActivityPage,
    Error,
    typeof getKey
  >(
    getKey,
    ([, , currentFilter, cursor]) =>
      backgroundActivityService.list({ filter: currentFilter, cursor }),
    { refreshInterval: 5000, revalidateFirstPage: true, shouldRetryOnError: false },
  );
  const items = [
    ...new Map(
      (data ?? [])
        .flatMap((page) => page.items)
        .map((item) => [`${item.category}:${item.id}`, item]),
    ).values(),
  ];
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  const stop = async (id: string) => {
    setStopping(id);
    setStopError(false);
    try {
      const item = items.find((item) => item.category === 'agent' && item.id === id);
      const result = await aiAgentService.interruptTask({
        operationId: id,
        ...(item?.threadId ? { threadId: item.threadId } : {}),
      });
      if (!result.success) setStopError(true);
      await mutate();
    } catch {
      setStopError(true);
    } finally {
      setStopping(undefined);
    }
  };

  return (
    <Drawer
      destroyOnHidden
      open
      closeIconProps={{ 'aria-label': t('backgroundActivity.close') }}
      placement={'right'}
      size={560}
      styles={{ body: { padding: 0 } }}
      title={t('backgroundActivity.title')}
      onClose={onClose}
    >
      <section aria-label={t('backgroundActivity.title')} className={styles.body}>
        <p className={styles.detail}>{t('backgroundActivity.description')}</p>
        <div
          aria-label={t('backgroundActivity.filterLabel')}
          className={styles.filters}
          role={'group'}
        >
          {ACTIVITY_FILTERS.map((value) => (
            <Button
              aria-pressed={value === filter}
              key={value}
              size={'small'}
              type={value === filter ? 'primary' : 'default'}
              onClick={() => setFilter(value)}
            >
              {t(`backgroundActivity.filter.${value}`)}
            </Button>
          ))}
        </div>
        <div className={styles.actions}>
          <Button
            aria-label={t('backgroundActivity.refresh')}
            loading={isValidating || monitoring.isValidating}
            size={'small'}
            onClick={() => void Promise.all([mutate(), monitoring.mutate()])}
          >
            {t('backgroundActivity.refresh')}
          </Button>
          <span className={styles.detail}>{t('backgroundActivity.autoRefresh')}</span>
        </div>
        {error && <Alert showIcon title={t('backgroundActivity.loadError')} type={'error'} />}
        {stopError && <Alert showIcon title={t('backgroundActivity.stopError')} type={'error'} />}
        <HealthSummary data={monitoring.data} error={monitoring.error} />
        {isLoading ? (
          <Spin />
        ) : !items.length && !error ? (
          <Empty description={t('backgroundActivity.empty')} />
        ) : null}
        <ul aria-busy={isValidating} className={styles.list}>
          {items.map((item) => (
            <li className={styles.card} key={`${item.category}:${item.id}`}>
              <div className={styles.heading}>
                <h3 className={styles.title}>
                  {item.taskTitle ||
                    item.title ||
                    item.agentTitle ||
                    t(`backgroundActivity.kind.${item.kind}`)}
                </h3>
                <Tag color={colors[item.status]}>
                  {t(`backgroundActivity.status.${item.status}`)}
                </Tag>
              </div>
              <p className={styles.detail}>
                {t(`backgroundActivity.kind.${item.kind}`)}
                {item.agentTitle && ` · ${item.agentTitle}`}
                {' · '}
                {t('backgroundActivity.attempts', { count: item.attempts })}
                {item.stepCount !== undefined &&
                  ` · ${t('backgroundActivity.steps', { count: item.stepCount })}`}
                <br />
                {t('backgroundActivity.updated', { time: date(item.updatedAt) })}
                {item.nextRunAt && (
                  <>
                    <br />
                    {t('backgroundActivity.nextRun', { time: date(item.nextRunAt) })}
                  </>
                )}
              </p>
              {item.status === 'unknown' && (
                <p className={styles.detail}>{t('backgroundActivity.unknownHelp')}</p>
              )}
              {item.status === 'waiting' && (
                <p className={styles.detail}>{t('backgroundActivity.waitingHelp')}</p>
              )}
              <div className={styles.actions}>
                {item.agentId && (
                  <Button size={'small'} onClick={() => setComputerAgentId(item.agentId)}>
                    {t('computer.open')}
                  </Button>
                )}
                {item.review && (
                  <p className={styles.detail}>
                    {t('backgroundActivity.review.recorded', {
                      decision: t(`backgroundActivity.review.decision.${item.review.decision}`),
                      time: date(item.review.reviewedAt),
                    })}
                    <br />
                    {item.review.evidence}
                  </p>
                )}
                {(item.incidentToken || item.hasReviewHistory) && (
                  <Button size={'small'} onClick={() => setReviewing(item)}>
                    {t(
                      item.review || !item.incidentToken
                        ? 'backgroundActivity.review.view'
                        : 'backgroundActivity.review.title',
                    )}
                  </Button>
                )}
                {item.agentId && item.topicId && (
                  <Link
                    to={`/agent/${encodeURIComponent(item.agentId)}/${encodeURIComponent(item.topicId)}${item.threadId ? `?thread=${encodeURIComponent(item.threadId)}` : ''}`}
                    onClick={onClose}
                  >
                    {t('backgroundActivity.openChat')}
                  </Link>
                )}
                {item.taskId && (
                  <Link to={`/task/${encodeURIComponent(item.taskId)}`} onClick={onClose}>
                    {t('backgroundActivity.openTask')}
                  </Link>
                )}
                {item.category === 'agent' && item.canStop && (
                  <Button
                    disabled={!!stopping}
                    loading={stopping === item.id}
                    size={'small'}
                    onClick={() => void stop(item.id)}
                  >
                    {t('backgroundActivity.stop')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {data?.at(-1)?.nextCursor && (
          <Button loading={isValidating} onClick={() => void setSize(size + 1)}>
            {t('backgroundActivity.loadMore')}
          </Button>
        )}
      </section>
      {computerAgentId && (
        <Suspense fallback={null}>
          <ComputerPanel
            agentId={computerAgentId}
            key={computerAgentId}
            ownerId={ownerId}
            onClose={() => setComputerAgentId(undefined)}
          />
        </Suspense>
      )}
      {reviewing && (
        <ReviewDialog
          item={reviewing}
          ownerId={ownerId}
          onCancel={() => setReviewing(undefined)}
          onSaved={() => {
            setReviewing(undefined);
            void mutate();
          }}
        />
      )}
    </Drawer>
  );
});

export default ActivityPanel;
