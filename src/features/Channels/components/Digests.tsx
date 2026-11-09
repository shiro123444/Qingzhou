'use client';

import { Button, Flexbox, Text } from '@lobehub/ui';
import { App, Checkbox, Empty, Input, Popconfirm, Select, Switch, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { lambdaClient } from '@/libs/trpc/client';
import { useUserStore } from '@/store/user';

import { styles } from '../styles';
import { LoadError, LoadingState } from './Page';

export default function ChannelDigests({ providerId }: { providerId: string }) {
  const { t } = useTranslation('common');
  const { message } = App.useApp();
  const userId = useUserStore((state) => state.user?.id);
  const [threadId, setThreadId] = useState<string>();
  const [scheduleTime, setScheduleTime] = useState('18:00');
  const [sendToSource, setSendToSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = useSWR(
    userId ? ['channel-digests', userId, providerId] : null,
    () => lambdaClient.channel.digests.query({ providerId }),
    { refreshInterval: 30_000 },
  );
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await data.mutate();
      message.success(t('channels.saved'));
    } catch {
      message.error(t('channels.actionFailed'));
    } finally {
      setBusy(false);
    }
  };
  if (data.isLoading) return <LoadingState />;
  if (data.error || !data.data) return <LoadError retry={() => void data.mutate()} />;
  if (!data.data.supported) return null;
  const { subscriptions, history, groups, canSend } = data.data;
  return (
    <section className={styles.panel}>
      <Flexbox gap={16}>
        <Text weight={600}>{t('channels.digest.title')}</Text>
        <Text className={styles.muted}>{t('channels.digest.hint')}</Text>
        {!canSend && <Text className={styles.muted}>{t('channels.digest.qqHint')}</Text>}
        {subscriptions.map((rule) => (
          <Flexbox gap={8} key={rule.id}>
            <Flexbox horizontal align="center" gap={12} wrap="wrap">
              <Text>{rule.threadId}</Text>
              <Text>{t('channels.digest.daily', { time: rule.scheduleTime })}</Text>
              <Switch
                aria-label={t('channels.digest.enabled')}
                checked={rule.enabled}
                disabled={busy}
                onChange={(enabled) =>
                  void perform(() =>
                    lambdaClient.channel.saveDigest.mutate({
                      providerId,
                      threadId: rule.threadId,
                      enabled,
                      scheduleTime: rule.scheduleTime,
                      sendToSource: rule.sendToSource,
                    }),
                  )
                }
              />
              <Button
                disabled={busy}
                onClick={() => {
                  setThreadId(rule.threadId);
                  setScheduleTime(rule.scheduleTime);
                  setSendToSource(rule.sendToSource);
                }}
              >
                {t('channels.configure')}
              </Button>
              <Popconfirm
                title={t('channels.digest.deleteConfirm')}
                onConfirm={() =>
                  perform(() =>
                    lambdaClient.channel.removeDigest.mutate({ providerId, ruleId: rule.id }),
                  )
                }
              >
                <Button danger disabled={busy}>
                  {t('channels.digest.delete')}
                </Button>
              </Popconfirm>
            </Flexbox>
            <Text className={styles.muted}>
              {t(rule.sendToSource ? 'channels.digest.send' : 'channels.digest.keep')}
            </Text>
          </Flexbox>
        ))}
        <Select
          aria-label={t('channels.digest.group')}
          disabled={busy}
          placeholder={t('channels.digest.group')}
          value={threadId}
          options={[
            ...new Set([
              ...groups.map((group) => group.threadId),
              ...subscriptions.map((rule) => rule.threadId),
            ]),
          ].map((value) => ({ label: value, value }))}
          onChange={setThreadId}
        />
        {!groups.length && <Text className={styles.muted}>{t('channels.digest.noGroups')}</Text>}
        <Flexbox horizontal align="center" gap={12}>
          <label htmlFor={`digest-time-${providerId}`}>{t('channels.digest.time')}</label>
          <Input
            disabled={busy}
            id={`digest-time-${providerId}`}
            style={{ width: 140 }}
            type="time"
            value={scheduleTime}
            onChange={(event) => setScheduleTime(event.target.value)}
          />
        </Flexbox>
        <Checkbox
          checked={sendToSource}
          disabled={busy || !canSend}
          onChange={(event) => setSendToSource(event.target.checked)}
        >
          {t('channels.digest.send')}
        </Checkbox>
        <Button
          disabled={busy || !threadId || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)}
          loading={busy}
          onClick={() =>
            void perform(() =>
              lambdaClient.channel.saveDigest.mutate({
                providerId,
                threadId: threadId!,
                scheduleTime,
                sendToSource: canSend && sendToSource,
                enabled: true,
              }),
            )
          }
        >
          {t('channels.digest.save')}
        </Button>
        <Text className={styles.muted}>{t('channels.digest.scheduleHint')}</Text>
        <Text weight={600}>{t('channels.digest.history')}</Text>
        {!history.length && (
          <Empty description={t('channels.digest.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
        {history.map(({ run, threadId: source, deliveryStatus }) => (
          <Flexbox gap={8} key={run.id}>
            <Text>
              {source} · {new Date(run.createdAt).toLocaleString()}
            </Text>
            <Tag>{t(`channels.digest.status.${run.status}`)}</Tag>
            {deliveryStatus && <Tag>{t(`channels.digest.delivery.${deliveryStatus}`)}</Tag>}
            {run.content && (
              <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {run.content}
              </Text>
            )}
          </Flexbox>
        ))}
      </Flexbox>
    </section>
  );
}
