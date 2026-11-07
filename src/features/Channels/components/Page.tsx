'use client';

import { Button, Flexbox } from '@lobehub/ui';
import { Alert, Breadcrumb, Empty, Skeleton } from 'antd';
import type { PropsWithChildren, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { styles } from '../styles';

export function ChannelPage({
  actions,
  children,
  crumbs = [],
  title,
}: PropsWithChildren<{
  actions?: ReactNode;
  crumbs?: Array<{ label: string; path?: string }>;
  title: string;
}>) {
  const { t } = useTranslation('common');
  return (
    <div className={styles.content}>
      <Breadcrumb
        items={[
          { title: <Link to="/channels">{t('channels.title')}</Link> },
          ...crumbs.map((crumb) => ({
            title: crumb.path ? <Link to={crumb.path}>{crumb.label}</Link> : crumb.label,
          })),
        ]}
      />
      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function LoadingState() {
  return <Skeleton active paragraph={{ rows: 5 }} title={false} />;
}

export function LoadError({ retry }: { retry: () => void }) {
  const { t } = useTranslation('common');
  return (
    <Alert
      showIcon
      title={t('channels.loadFailed')}
      type="error"
      action={
        <Button size="small" onClick={retry}>
          {t('channels.retry')}
        </Button>
      }
    />
  );
}

export function NoProviders({ action }: { action?: ReactNode }) {
  const { t } = useTranslation('common');
  return (
    <Flexbox align="center" className={styles.panel} gap={16} paddingBlock={48}>
      <Empty description={t('channels.noBots')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      {action}
    </Flexbox>
  );
}
