'use client';

import { Button, Flexbox, Text } from '@lobehub/ui';
import { App, Descriptions, Empty, Modal, Popconfirm, Switch, Typography } from 'antd';
import { Link2, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import useSWR from 'swr';

import { lambdaClient } from '@/libs/trpc/client';
import { useUserStore } from '@/store/user';
import type { ChannelAccessSettings } from '@/types/channel';

import { styles } from '../styles';
import { LoadError, LoadingState } from './Page';

interface Challenge {
  code: string;
  command: string;
  expiresAt: number;
}

export default function ChannelAccess({
  configurationUrl,
  enabled,
  providerId,
  settings,
}: {
  configurationUrl: string;
  enabled: boolean;
  providerId: string;
  settings: ChannelAccessSettings;
}) {
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge>();
  const [expired, setExpired] = useState(false);
  const userId = useUserStore((state) => state.user?.id);
  const identity = useSWR(
    userId ? ['channel-workspace:identities', userId, providerId] : null,
    () => lambdaClient.channelIdentity.list.query({ providerId }),
    { refreshInterval: 5000 },
  );

  useEffect(() => {
    if (!challenge) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, challenge.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [challenge]);
  useEffect(() => {
    if (challenge && identity.data?.identities.length) {
      setChallenge(undefined);
      message.success(t('channels.bindingComplete'));
    }
  }, [challenge, identity.data?.identities.length, message, t]);

  const create = async () => {
    setBusy(true);
    try {
      const result = await lambdaClient.channelIdentity.createChallenge.mutate({ providerId });
      setExpired(false);
      setChallenge(result);
    } catch {
      message.error(t('channels.actionFailed'));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (linkId: string) => {
    setBusy(true);
    try {
      await lambdaClient.channelIdentity.revoke.mutate({ providerId, linkId });
      await identity.mutate();
      message.success(t('channels.bindingRevoked'));
    } catch {
      message.error(t('channels.actionFailed'));
    } finally {
      setBusy(false);
    }
  };
  const updatePermissions = async (requireBinding: boolean) => {
    setBusy(true);
    try {
      await lambdaClient.channelIdentity.updatePermissions.mutate({ providerId, requireBinding });
      await identity.mutate();
      message.success(t('channels.saved'));
    } catch {
      message.error(t('channels.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (identity.isLoading) return <LoadingState />;
  if (identity.error) return <LoadError retry={() => void identity.mutate()} />;
  return (
    <Flexbox gap={24}>
      <section className={styles.panel}>
        <Flexbox horizontal align="center" gap={16} justify="space-between">
          <Text weight={600}>{t('channels.myIdentity')}</Text>
          <Button
            disabled={!enabled || !identity.data?.supported || !!identity.data.identities.length}
            icon={Link2}
            loading={busy}
            onClick={create}
          >
            {t('channels.bindAccount')}
          </Button>
        </Flexbox>
        {!enabled && <Text className={styles.muted}>{t('channels.enableToBind')}</Text>}
        {identity.data?.identities.length ? (
          identity.data.identities.map((item) => (
            <Flexbox
              horizontal
              align="center"
              gap={16}
              justify="space-between"
              key={item.id}
              paddingBlock={20}
            >
              <Flexbox gap={4}>
                <Text weight={500}>{item.platformUsername || item.platformUserId}</Text>
                <Text className={styles.muted}>{item.platformUserId}</Text>
                <Text className={styles.muted}>
                  {t('channels.boundAt', { date: new Date(item.createdAt).toLocaleString() })}
                </Text>
              </Flexbox>
              <Popconfirm
                cancelText={t('channels.cancel')}
                okText={t('channels.revoke')}
                title={t('channels.revokeConfirm')}
                onConfirm={() => revoke(item.id)}
              >
                <Button danger disabled={busy} icon={Unlink}>
                  {t('channels.revoke')}
                </Button>
              </Popconfirm>
            </Flexbox>
          ))
        ) : (
          <Empty description={t('channels.noIdentity')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </section>
      <section className={styles.panel}>
        <Flexbox horizontal align="center" gap={16} justify="space-between">
          <Flexbox gap={4}>
            <Text weight={600}>{t('channels.requireBinding')}</Text>
            <Text className={styles.muted}>{t('channels.requireBindingHint')}</Text>
          </Flexbox>
          <Switch
            aria-label={t('channels.requireBinding')}
            checked={identity.data?.permissions.requireBinding ?? false}
            disabled={busy || !identity.data?.supported}
            loading={busy}
            onChange={updatePermissions}
          />
        </Flexbox>
        <Descriptions
          column={1}
          size="small"
          style={{ marginBlockStart: 24 }}
          items={[
            {
              key: 'dm',
              label: t('channels.dmPolicy'),
              children: t(`channels.policy.${settings.dmPolicy}` as 'channels.policy.open'),
            },
            {
              key: 'group',
              label: t('channels.groupPolicy'),
              children: t(`channels.policy.${settings.groupPolicy}` as 'channels.policy.open'),
            },
            {
              key: 'allow',
              label: t('channels.allowlist'),
              children: settings.allowFrom.length
                ? settings.allowFrom.map((entry) => entry.name || entry.id).join('、')
                : t('channels.notSet'),
            },
          ]}
        />
        <Link to={configurationUrl}>{t('channels.editAccessPolicy')}</Link>
      </section>
      <Modal
        footer={null}
        open={!!challenge}
        title={t('channels.bindAccount')}
        onCancel={() => setChallenge(undefined)}
      >
        {challenge && (
          <Flexbox gap={16} paddingBlock={12}>
            <Text>{t('channels.bindInstructions')}</Text>
            {!expired ? (
              <>
                <Typography.Paragraph
                  code
                  copyable={{ text: challenge.command }}
                  style={{ fontSize: 20, margin: 0 }}
                >
                  {challenge.command}
                </Typography.Paragraph>
                <Text className={styles.muted}>
                  {t('channels.codeExpiresAt', {
                    date: new Date(challenge.expiresAt).toLocaleTimeString(),
                  })}
                </Text>
                <Text type="secondary">{t('channels.waitingForBinding')}</Text>
              </>
            ) : (
              <>
                <Text type="secondary">{t('channels.codeExpired')}</Text>
                <Button loading={busy} onClick={create}>
                  {t('channels.regenerate')}
                </Button>
              </>
            )}
          </Flexbox>
        )}
      </Modal>
    </Flexbox>
  );
}
