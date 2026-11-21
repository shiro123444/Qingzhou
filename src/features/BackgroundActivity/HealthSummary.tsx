import { Alert, Spin, Tag } from 'antd';
import { useTranslation } from 'react-i18next';

import type { ActivityHealth } from '@/types/backgroundActivity';

import { styles } from './style';

export default function HealthSummary({ data, error }: { data?: ActivityHealth; error?: unknown }) {
  const { t, i18n } = useTranslation('chat');
  if (error)
    return <Alert showIcon title={t('backgroundActivity.health.error')} type={'warning'} />;
  if (!data) return <Spin size={'small'} />;
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  return (
    <section aria-label={t('backgroundActivity.health.title')} className={styles.card}>
      <h3 className={styles.title}>{t('backgroundActivity.health.title')}</h3>
      {data.workers.map((worker) => (
        <div key={worker.kind}>
          <div className={styles.heading}>
            <span>{t(`backgroundActivity.health.kind.${worker.kind}`)}</span>
            <Tag
              color={
                ['online', 'busy'].includes(worker.status)
                  ? 'success'
                  : ['degraded', 'unresponsive'].includes(worker.status)
                    ? 'warning'
                    : 'default'
              }
            >
              {t(`backgroundActivity.health.status.${worker.status}`)}
            </Tag>
          </div>
          <p className={styles.detail}>
            {worker.heartbeatAt && (
              <>
                {t('backgroundActivity.health.heartbeat', { time: date(worker.heartbeatAt) })}
                <br />
              </>
            )}
            {worker.lastSuccessAt && (
              <>
                {t('backgroundActivity.health.lastSuccess', { time: date(worker.lastSuccessAt) })}
                <br />
              </>
            )}
            {worker.lastPollAt && (
              <>
                {t('backgroundActivity.health.lastPoll', { time: date(worker.lastPollAt) })}
                <br />
              </>
            )}
            {worker.lastFailureAt && (
              <>
                {t('backgroundActivity.health.lastFailure', { time: date(worker.lastFailureAt) })}
                <br />
              </>
            )}
            {worker.consecutiveFailures > 0 && (
              <>
                {t('backgroundActivity.health.failures', { count: worker.consecutiveFailures })}
                <br />
              </>
            )}
            {worker.degradedInstances > 0 && (
              <>
                {t('backgroundActivity.health.degradedInstances', {
                  count: worker.degradedInstances,
                })}
                <br />
              </>
            )}
            {worker.status === 'unobserved' && t('backgroundActivity.health.unobservedHelp')}
            {worker.status === 'unresponsive' && t('backgroundActivity.health.unresponsiveHelp')}
          </p>
        </div>
      ))}
      <p className={styles.detail}>
        {t('backgroundActivity.health.queue', { ...data.queue })}
        <br />
        {t('backgroundActivity.health.delay', { seconds: data.queue.oldestReadyAgeSeconds })}
        <br />
        {t('backgroundActivity.health.quarantineHelp')}
        <br />
        {t('backgroundActivity.health.checkedAt', { time: date(data.checkedAt) })}
      </p>
    </section>
  );
}
