'use client';

import { Button, Flexbox, Text } from '@lobehub/ui';
import { App, Descriptions, Empty, Switch, Table, Tag } from 'antd';
import { PlugZap, RefreshCw, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import useSWR, { mutate } from 'swr';

import { agentBotProviderService } from '@/services/agentBotProvider';
import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';

import ChannelAccess from '../components/Access';
import { ChannelPage, LoadError, LoadingState } from '../components/Page';
import ChannelStatus from '../components/Status';
import {
  CHANNEL_SECTIONS,
  channelPath,
  configurationPath,
  isChannelPlatform,
  matchesPlatform,
} from '../constants';
import { CHANNEL_LIST_KEY } from '../data';
import { styles } from '../styles';

export default function ChannelProviderPage() {
  const { platform, providerId, section = 'overview' } = useParams();
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const [busy, setBusy] = useState<string>();
  const userId = useUserStore((state) => state.user?.id);
  const detail = useSWR(
    providerId && userId ? ['channel-workspace:detail', userId, providerId] : null,
    () => channelService.detail(providerId!),
    { refreshInterval: 15_000 },
  );
  if (!isChannelPlatform(platform) || !providerId) return <Navigate replace to="/channels" />;
  if (!(CHANNEL_SECTIONS as readonly string[]).includes(section))
    return <Navigate replace to={channelPath(platform, providerId)} />;
  if (detail.isLoading)
    return (
      <ChannelPage title={t('channels.loading')}>
        <LoadingState />
      </ChannelPage>
    );
  if (detail.error || !detail.data)
    return (
      <ChannelPage title={t('channels.bot')}>
        <LoadError retry={() => void detail.mutate()} />
      </ChannelPage>
    );
  const { provider, settings, activity } = detail.data;
  if (!matchesPlatform(provider.platform, platform))
    return <Navigate replace to={channelPath(provider.platform, provider.id, section)} />;
  const configurationUrl = configurationPath(provider.agentId, provider.platform);
  const perform = async (action: 'connect' | 'toggle', enabled?: boolean) => {
    setBusy(action);
    try {
      if (action === 'toggle') {
        await agentBotProviderService.update(provider.id, { enabled });
        message.success(t('channels.saved'));
      } else {
        const result = await agentBotProviderService.connectBot({
          applicationId: provider.applicationId,
          platform: provider.platform,
        });
        message.info(
          t(result.status === 'queued' ? 'channels.connectQueued' : 'channels.connectStarted'),
        );
      }
      await Promise.all([detail.mutate(), mutate([CHANNEL_LIST_KEY, userId])]);
    } catch {
      message.error(t('channels.actionFailed'));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <ChannelPage
      title={provider.agentTitle || provider.applicationId}
      actions={
        <>
          <Button
            icon={RefreshCw}
            loading={detail.isValidating}
            onClick={() => void detail.mutate()}
          >
            {t('channels.refresh')}
          </Button>
          <Link to={configurationUrl}>
            <Button icon={Settings2}>{t('channels.configure')}</Button>
          </Link>
        </>
      }
      crumbs={[
        { label: t(`channels.platforms.${platform}`), path: `/channels/${platform}` },
        {
          label: provider.agentTitle || provider.applicationId,
          path: channelPath(platform, providerId),
        },
        { label: t(`channels.sections.${section}` as 'channels.sections.overview') },
      ]}
    >
      {section === 'overview' && (
        <Flexbox gap={24}>
          <section className={styles.panel}>
            <Flexbox horizontal align="center" gap={16} justify="space-between">
              <ChannelStatus provider={provider} />
              <div className={styles.actions}>
                <Text>{t('channels.enabled')}</Text>
                <Switch
                  aria-label={t('channels.enabled')}
                  checked={provider.enabled}
                  disabled={!!busy}
                  loading={busy === 'toggle'}
                  onChange={(enabled) => void perform('toggle', enabled)}
                />
                <Button
                  disabled={!provider.enabled || !!busy}
                  icon={PlugZap}
                  loading={busy === 'connect'}
                  onClick={() => void perform('connect')}
                >
                  {t('channels.connect')}
                </Button>
              </div>
            </Flexbox>
            <Descriptions
              column={{ lg: 2, sm: 1, xs: 1 }}
              size="small"
              style={{ marginBlockStart: 28 }}
              items={[
                {
                  key: 'platform',
                  label: t('channels.platform'),
                  children:
                    provider.platform === 'lark' ? 'Lark' : t(`channels.platforms.${platform}`),
                },
                {
                  key: 'application',
                  label: t('channels.applicationId'),
                  children: provider.applicationId,
                },
                {
                  key: 'mode',
                  label: t('channels.connectionMode'),
                  children: t(`channels.mode.${provider.connectionMode}`),
                },
                {
                  key: 'updated',
                  label: t('channels.lastUpdated'),
                  children: provider.runtimeStatus.updatedAt
                    ? new Date(provider.runtimeStatus.updatedAt).toLocaleString()
                    : t('channels.notObserved'),
                },
              ]}
            />
          </section>
          <div className={styles.grid}>
            {(['access', 'activity'] as const).map((value) => (
              <Link
                className={styles.link}
                key={value}
                to={channelPath(platform, providerId, value)}
              >
                <Flexbox className={styles.panel} gap={6}>
                  <Text weight={600}>{t(`channels.sections.${value}`)}</Text>
                  <Text className={styles.muted}>{t(`channels.open.${value}`)}</Text>
                </Flexbox>
              </Link>
            ))}
          </div>
        </Flexbox>
      )}
      {section === 'access' && (
        <ChannelAccess
          configurationUrl={configurationUrl}
          enabled={provider.enabled}
          key={`${userId}:${provider.id}`}
          providerId={provider.id}
          settings={settings}
        />
      )}
      {section === 'activity' && (
        <Flexbox gap={16}>
          <Flexbox horizontal align="center" justify="space-between">
            <Text weight={600}>{t('channels.recentInbound')}</Text>
            <Link to="/settings/bot-delivery">{t('channels.delivery')}</Link>
          </Flexbox>
          {activity.length ? (
            <Table
              dataSource={activity}
              pagination={false}
              rowKey="id"
              scroll={{ x: 550 }}
              columns={[
                {
                  title: t('channels.receivedAt'),
                  dataIndex: 'createdAt',
                  render: (value) => new Date(value).toLocaleString(),
                },
                {
                  title: t('channels.state'),
                  dataIndex: 'status',
                  render: (value: string) => (
                    <Tag>
                      {t(`channels.eventStatus.${value}` as 'channels.eventStatus.pending')}
                    </Tag>
                  ),
                },
                { title: t('channels.attempts'), dataIndex: 'attempts', width: 120 },
                {
                  title: t('channels.lastUpdated'),
                  dataIndex: 'updatedAt',
                  render: (value) => new Date(value).toLocaleString(),
                },
              ]}
            />
          ) : (
            <Empty description={t('channels.noActivity')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Flexbox>
      )}
    </ChannelPage>
  );
}
