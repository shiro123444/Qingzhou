'use client';

import { Empty, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import useSWR from 'swr';

import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';

import { channelPath } from '../constants';
import { styles } from '../styles';
import { LoadError, LoadingState } from './Page';

export default function ChannelTasks({
  platform,
  providerId,
}: {
  platform: string;
  providerId: string;
}) {
  const { t } = useTranslation('common');
  const userId = useUserStore((s) => s.user?.id);
  const tasks = useSWR(
    userId ? ['channel-tasks', userId, providerId] : null,
    () => channelService.tasks(providerId),
    { refreshInterval: 10_000 },
  );
  if (tasks.isLoading) return <LoadingState />;
  if (tasks.error) return <LoadError retry={() => void tasks.mutate()} />;
  return (
    <section className={styles.taskSection}>
      <h2 className={styles.sectionTitle}>{t('channels.tasks.title')}</h2>
      {!tasks.data?.length ? (
        <Empty description={t('channels.tasks.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Table
          rowKey="id"
          dataSource={tasks.data}
          pagination={false}
          scroll={{ x: 520 }}
          columns={[
            {
              title: t('channels.tasks.task'),
              key: 'task',
              render: (_, task) => (
                <Link
                  to={`${channelPath(platform, providerId, 'activity')}/tasks/${task.id}`}
                  title={task.operationId}
                >
                  {t('channels.tasks.task')} {task.id.slice(0, 8)}
                </Link>
              ),
            },
            {
              title: t('channels.state'),
              key: 'state',
              render: (_, task) => (
                <Tag>
                  {t(
                    `channels.tasks.status.${!task.completed && task.delivery !== 'unknown' ? 'running' : task.delivery}`,
                  )}
                </Tag>
              ),
            },
            {
              title: t('channels.receivedAt'),
              dataIndex: 'createdAt',
              render: (value) => new Date(value).toLocaleString(),
            },
          ]}
        />
      )}
    </section>
  );
}
