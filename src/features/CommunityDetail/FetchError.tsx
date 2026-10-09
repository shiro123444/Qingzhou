'use client';

import { Button, Flexbox, Text } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

interface FetchErrorProps {
  error: unknown;
  onRetry: () => void;
}

export default function CommunityDetailFetchError({ error, onRetry }: FetchErrorProps) {
  const { t } = useTranslation('error');
  const details = error as { data?: { code?: string; httpStatus?: number }; status?: number };
  const missing =
    details?.data?.code === 'NOT_FOUND' ||
    details?.data?.httpStatus === 404 ||
    details?.status === 404;

  return (
    <Flexbox align="center" gap={16} justify="center" role="alert" style={{ minHeight: 400 }}>
      <Text fontSize={20} weight={500}>
        {t(missing ? 'notFound.title' : 'fetchError.title')}
      </Text>
      {!missing && <Button onClick={onRetry}>{t('error.retry')}</Button>}
    </Flexbox>
  );
}
