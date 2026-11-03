import { Button } from '@lobehub/ui';
import { Table } from 'antd';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { channelPath } from '../constants';
import type { ChannelProvider } from '../data';
import ChannelStatus from './Status';

export default function ProviderTable({ providers }: { providers: ChannelProvider[] }) {
  const { t } = useTranslation('common');
  return (
    <Table
      dataSource={providers}
      pagination={false}
      rowKey="id"
      scroll={{ x: 620 }}
      columns={[
        {
          title: t('channels.bot'),
          dataIndex: 'agentTitle',
          render: (_, provider) => (
            <Link to={channelPath(provider.platform, provider.id)}>
              {provider.agentTitle || t('channels.untitledAgent')}
            </Link>
          ),
        },
        { title: t('channels.applicationId'), dataIndex: 'applicationId', ellipsis: true },
        {
          title: t('channels.state'),
          width: 120,
          render: (_, provider) => <ChannelStatus provider={provider} />,
        },
        {
          title: t('channels.lastUpdated'),
          dataIndex: 'updatedAt',
          render: (value) => new Date(value).toLocaleString(),
        },
        {
          key: 'open',
          width: 48,
          render: (_, provider) => (
            <Link to={channelPath(provider.platform, provider.id)}>
              <Button
                aria-label={t('channels.openBot')}
                icon={ChevronRight}
                size="small"
                type="text"
              />
            </Link>
          ),
        },
      ]}
    />
  );
}
