import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';

import type { ChannelProvider } from '../data';

export default function ChannelStatus({ provider }: { provider: ChannelProvider }) {
  const { t } = useTranslation('common');
  const status = provider.enabled ? provider.runtimeStatus.status : 'disabled';
  return (
    <Tag color={status === 'connected' ? 'success' : status === 'failed' ? 'error' : undefined}>
      {t(`channels.status.${status}` as 'channels.status.connected')}
    </Tag>
  );
}
