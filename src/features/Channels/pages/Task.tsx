'use client';

import { Button, Flexbox, Text } from '@lobehub/ui';
import { Alert, App, Descriptions, Tag } from 'antd';
import { Copy, MessageSquare, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import useSWR from 'swr';

import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';

import { ChannelPage, LoadError, LoadingState } from '../components/Page';
import { channelPath, isChannelPlatform, matchesPlatform } from '../constants';
import { styles } from '../styles';

export default function ChannelTaskPage() {
  const { platform, providerId, taskId } = useParams();
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const userId = useUserStore((s) => s.user?.id);
  const result = useSWR(
    userId && providerId && taskId ? ['channel-task', userId, providerId, taskId] : null,
    () => channelService.task(providerId!, taskId!),
    { refreshInterval: 10_000 },
  );
  if (!isChannelPlatform(platform) || !providerId || !taskId)
    return <Navigate replace to="/channels" />;
  if (result.isLoading)
    return (
      <ChannelPage title={t('channels.tasks.detail')}>
        <LoadingState />
      </ChannelPage>
    );
  if (result.error || !result.data)
    return (
      <ChannelPage title={t('channels.tasks.detail')}>
        <LoadError retry={() => void result.mutate()} />
      </ChannelPage>
    );
  const task = result.data;
  if (!matchesPlatform(task.provider.platform, platform))
    return <Navigate replace to="/channels" />;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(t('channels.tasks.copied'));
    } catch {
      message.error(t('channels.actionFailed'));
    }
  };
  return (
    <ChannelPage
      title={t('channels.tasks.detail')}
      crumbs={[
        { label: t(`channels.platforms.${platform}`), path: `/channels/${platform}` },
        {
          label: task.provider.agentTitle || task.provider.applicationId,
          path: channelPath(platform, providerId),
        },
        {
          label: t('channels.sections.activity'),
          path: channelPath(platform, providerId, 'activity'),
        },
        { label: t('channels.tasks.detail') },
      ]}
      actions={
        <>
          <Button
            icon={RefreshCw}
            loading={result.isValidating}
            onClick={() => void result.mutate()}
          >
            {t('channels.refresh')}
          </Button>
          {task.topicId && (
            <Link to={`/agent/${task.provider.agentId}?topic=${encodeURIComponent(task.topicId)}`}>
              <Button icon={MessageSquare}>{t('channels.tasks.conversation')}</Button>
            </Link>
          )}
        </>
      }
    >
      <Flexbox gap={24}>
        <Flexbox horizontal align="center" justify="space-between" gap={12}>
          <Tag>
            {t(
              `channels.tasks.status.${!task.completed && task.delivery !== 'unknown' ? 'running' : task.delivery}`,
            )}
          </Tag>
          {task.completed && (
            <Button icon={Copy} size="small" onClick={() => void copy(`/result ${task.id}`)}>
              {t('channels.tasks.copyCommand')}
            </Button>
          )}
        </Flexbox>
        {task.delivery === 'retained' && (
          <Alert
            type="info"
            showIcon
            title={t('channels.tasks.retained')}
            description={t(
              `channels.tasks.reason.${task.reason}` as 'channels.tasks.reason.platform_rejected',
              { defaultValue: t('channels.tasks.retained') },
            )}
          />
        )}
        {task.delivery === 'unknown' && (
          <Alert
            type="warning"
            showIcon
            title={t('channels.tasks.unknown')}
            action={<Link to="/settings/bot-delivery">{t('channels.delivery')}</Link>}
          />
        )}
        <section className={styles.panel}>
          <Flexbox horizontal justify="space-between" align="center">
            <h2 className={styles.sectionTitle}>{t('channels.tasks.result')}</h2>
            <Button
              disabled={!task.content}
              icon={Copy}
              size="small"
              onClick={() => void copy(task.content)}
            >
              {t('channels.tasks.copy')}
            </Button>
          </Flexbox>
          <div className={styles.result}>
            {task.content || t(task.completed ? 'channels.tasks.noText' : 'channels.tasks.running')}
          </div>
          {!!task.artifactIds.length && (
            <Text className={styles.muted}>
              {t('channels.tasks.files', { count: task.artifactIds.length })}
            </Text>
          )}
        </section>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2 }}
          items={[
            {
              key: 'id',
              label: t('channels.tasks.task'),
              children: <span title={task.operationId}>{task.id.slice(0, 8)}</span>,
            },
            {
              key: 'time',
              label: t('channels.lastUpdated'),
              children: new Date(task.updatedAt).toLocaleString(),
            },
          ]}
        />
      </Flexbox>
    </ChannelPage>
  );
}
