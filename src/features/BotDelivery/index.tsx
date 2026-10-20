'use client';

import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { createStaticStyles } from 'antd-style';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { lambdaClient } from '@/libs/trpc/client';

const styles = createStaticStyles(({ css, cssVar }) => ({
  page: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    color: ${cssVar.colorText};
  `,
  summary: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
}));
type Status = 'pending' | 'running' | 'transferred' | 'delivered' | 'unknown' | 'dead';
type Action =
  | { kind: 'retry'; jobId: string }
  | { kind: 'reconcile'; scopeKey: string; effectId: string; revision: number }
  | { kind: 'inbound'; id: string; updatedAt: string };
interface RecoveryForm {
  acknowledge: boolean;
  evidence: string;
  note: string;
  resolution: string;
}

export default function BotDeliveryPage() {
  const { t } = useTranslation('setting');
  const { message } = App.useApp();
  const [status, setStatus] = useState<Status>();
  const [scope, setScope] = useState<string>();
  const [before, setBefore] = useState<{ createdAt: string; id: string }>();
  const [history, setHistory] = useState<Array<{ createdAt: string; id: string } | undefined>>([]);
  const [action, setAction] = useState<Action>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<RecoveryForm>();
  const jobs = useSWR(
    ['bot-delivery', status, before],
    () => lambdaClient.botDelivery.list.query({ status, before, limit: 30 }),
    { refreshInterval: 15_000 },
  );
  const stats = useSWR('bot-delivery-stats', () => lambdaClient.botDelivery.stats.query(), {
    refreshInterval: 15_000,
  });
  const incoming = useSWR('bot-delivery-inbound', () => lambdaClient.botDelivery.inbound.query(), {
    refreshInterval: 15_000,
  });
  const detail = useSWR(scope ? ['bot-delivery-scope', scope] : null, () =>
    lambdaClient.botDelivery.inspect.query({ scopeKey: scope! }),
  );
  const refresh = async () => {
    await Promise.all([jobs.mutate(), stats.mutate(), incoming.mutate(), detail.mutate()]);
  };
  const openAction = (value: Action) => {
    form.resetFields();
    setAction(value);
  };
  const recover = async () => {
    const values = await form.validateFields();
    if (!action || !values.acknowledge) return;
    setSaving(true);
    try {
      const common = {
        evidence: values.evidence,
        note: values.note,
        acknowledgeDuplicateRisk: true as const,
      };
      if (action.kind === 'retry')
        await lambdaClient.botDelivery.retryDead.mutate({ ...common, jobId: action.jobId });
      else if (action.kind === 'inbound')
        await lambdaClient.botDelivery.reconcileInbound.mutate({
          ...common,
          id: action.id,
          expectedUpdatedAt: action.updatedAt,
          resolution: values.resolution as 'processed' | 'retry',
        });
      else
        await lambdaClient.botDelivery.reconcile.mutate({
          ...common,
          scopeKey: action.scopeKey,
          effectId: action.effectId,
          expectedRevision: action.revision,
          resolution: values.resolution as 'confirmed_delivered' | 'confirmed_not_delivered',
        });
      setAction(undefined);
      await refresh();
      message.success(t('botDelivery.saved'));
    } catch {
      message.error(t('botDelivery.recoveryFailed'));
    } finally {
      setSaving(false);
    }
  };
  const label = (value: string) => t(`botDelivery.status.${value}` as 'botDelivery.status.pending');
  return (
    <div className={styles.page}>
      <Space>
        <Typography.Title level={3}>{t('botDelivery.title')}</Typography.Title>
        <Button onClick={refresh}>{t('botDelivery.refresh')}</Button>
      </Space>
      <Typography.Paragraph>{t('botDelivery.description')}</Typography.Paragraph>
      {(jobs.error || stats.error || incoming.error) && (
        <Alert type="error" showIcon title={t('botDelivery.loadFailed')} />
      )}
      <div className={styles.summary}>
        {stats.data?.map((row) => (
          <Tag key={`${row.role}:${row.status}`}>
            {t(`botDelivery.role.${row.role}`)} · {label(row.status)}: {row.count}
            {row.oldestAt &&
              ` · ${t('botDelivery.oldest', { date: new Date(row.oldestAt).toLocaleString() })}`}
          </Tag>
        ))}
      </div>
      <Select
        allowClear
        placeholder={t('botDelivery.filter')}
        style={{ width: 220 }}
        value={status}
        options={['pending', 'running', 'transferred', 'delivered', 'unknown', 'dead'].map(
          (value) => ({ value, label: label(value) }),
        )}
        onChange={(value: Status | undefined) => {
          setStatus(value);
          setBefore(undefined);
          setHistory([]);
        }}
      />
      <Table
        dataSource={jobs.data?.items}
        loading={jobs.isLoading}
        pagination={false}
        rowKey="id"
        scroll={{ x: 700 }}
        columns={[
          { title: t('botDelivery.operation'), dataIndex: 'operationId', ellipsis: true },
          {
            title: t('botDelivery.state'),
            dataIndex: 'status',
            render: (value: string) => <Tag>{label(value)}</Tag>,
          },
          { title: t('botDelivery.attempts'), dataIndex: 'attempts', width: 90 },
          {
            title: t('botDelivery.createdAt'),
            dataIndex: 'createdAt',
            render: (date: string | Date) => new Date(date).toLocaleString(),
          },
          { title: t('botDelivery.error'), dataIndex: 'errorCode' },
          {
            title: t('botDelivery.actions'),
            render: (_, row) => (
              <Space>
                <Button onClick={() => setScope(row.scopeKey)}>{t('botDelivery.inspect')}</Button>
                {row.status === 'dead' && (
                  <Button onClick={() => openAction({ kind: 'retry', jobId: row.id })}>
                    {t('botDelivery.retry')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Space>
        <Button
          disabled={!history.length}
          onClick={() => {
            setBefore(history.at(-1));
            setHistory(history.slice(0, -1));
          }}
        >
          {t('botDelivery.previous')}
        </Button>
        <Button
          disabled={!jobs.data?.nextCursor}
          onClick={() => {
            setHistory([...history, before]);
            setBefore(jobs.data!.nextCursor!);
          }}
        >
          {t('botDelivery.next')}
        </Button>
      </Space>
      <Typography.Title level={4}>{t('botDelivery.inbound')}</Typography.Title>
      <Table
        rowKey="id"
        pagination={{ pageSize: 10 }}
        dataSource={incoming.data}
        scroll={{ x: 650 }}
        columns={[
          { title: t('botDelivery.platform'), dataIndex: 'platform' },
          { title: t('botDelivery.event'), dataIndex: 'eventId', ellipsis: true },
          { title: t('botDelivery.state'), dataIndex: 'status', render: label },
          { title: t('botDelivery.error'), dataIndex: 'errorCode' },
          {
            title: t('botDelivery.actions'),
            render: (_, row) =>
              ['unknown', 'dead'].includes(row.status) ? (
                <Button
                  onClick={() =>
                    openAction({
                      kind: 'inbound',
                      id: row.id,
                      updatedAt: new Date(row.updatedAt).toISOString(),
                    })
                  }
                >
                  {t('botDelivery.inspect')}
                </Button>
              ) : null,
          },
        ]}
      />
      <Modal
        open={!!scope}
        title={t('botDelivery.inspect')}
        footer={null}
        onCancel={() => setScope(undefined)}
      >
        {detail.error && <Alert type="error" title={t('botDelivery.loadFailed')} />}
        <Typography.Paragraph>{detail.data?.destination?.platformThreadId}</Typography.Paragraph>
        {Object.entries(detail.data?.ledger?.state.effects ?? {}).map(([effectId, state]) => (
          <Space key={effectId} style={{ display: 'flex', marginBottom: 8 }}>
            <Typography.Text>{effectId}</Typography.Text>
            <Tag>{state}</Tag>
            {state === 'unknown_delivery' && (
              <Button
                onClick={() =>
                  openAction({
                    kind: 'reconcile',
                    scopeKey: scope!,
                    effectId,
                    revision: detail.data!.ledger!.revision,
                  })
                }
              >
                {t('botDelivery.reconcile')}
              </Button>
            )}
          </Space>
        ))}
        <Typography.Title level={5}>{t('botDelivery.audit')}</Typography.Title>
        {detail.data?.audits.map((audit) => (
          <Typography.Paragraph key={audit.id}>
            {audit.action} · {audit.note} · {audit.evidence}
          </Typography.Paragraph>
        ))}
      </Modal>
      <Modal
        open={!!action}
        title={t('botDelivery.reconcile')}
        confirmLoading={saving}
        onOk={recover}
        onCancel={() => setAction(undefined)}
      >
        <Alert
          showIcon
          type="warning"
          title={t('botDelivery.recoveryHint')}
          style={{ marginBottom: 16 }}
        />
        <Form form={form} layout="vertical">
          {action?.kind !== 'retry' && (
            <Form.Item
              name="resolution"
              label={t('botDelivery.resolution')}
              rules={[{ required: true }]}
            >
              <Select
                options={
                  action?.kind === 'inbound'
                    ? [
                        { value: 'processed', label: t('botDelivery.confirmProcessed') },
                        { value: 'retry', label: t('botDelivery.retry') },
                      ]
                    : [
                        { value: 'confirmed_delivered', label: t('botDelivery.confirmDelivered') },
                        {
                          value: 'confirmed_not_delivered',
                          label: t('botDelivery.confirmNotDelivered'),
                        },
                      ]
                }
              />
            </Form.Item>
          )}
          <Form.Item
            name="note"
            label={t('botDelivery.note')}
            rules={[{ required: true, min: 8, max: 1000 }]}
          >
            <Input.TextArea />
          </Form.Item>
          <Form.Item
            name="evidence"
            label={t('botDelivery.evidence')}
            rules={[{ required: true, min: 8, max: 2000 }]}
          >
            <Input.TextArea />
          </Form.Item>
          <Form.Item
            name="acknowledge"
            valuePropName="checked"
            rules={[
              {
                validator: (_, value) =>
                  value
                    ? Promise.resolve()
                    : Promise.reject(new Error(t('botDelivery.acknowledge'))),
              },
            ]}
          >
            <Checkbox>{t('botDelivery.acknowledge')}</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
