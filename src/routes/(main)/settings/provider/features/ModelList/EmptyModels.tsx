import { Button, Center, Flexbox, Icon } from '@lobehub/ui';
import { App } from 'antd';
import { createStaticStyles } from 'antd-style';
import { BrainIcon, LucideRefreshCcwDot, PlusIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiInfraStore } from '@/store/aiInfra';

import CreateNewModelModal from './CreateNewModelModal';

const styles = createStaticStyles(({ css, cssVar }) => ({
  circle: css`
    width: 80px;
    height: 80px;
    border-radius: 50%;
    background: ${cssVar.colorFillSecondary};
  `,
  container: css`
    width: 100%;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
  `,
  description: css`
    max-width: 280px;

    font-size: ${cssVar.fontSize};
    color: ${cssVar.colorTextDescription};
    text-align: center;
    text-wrap: balance;
  `,
  iconWrapper: css`
    position: relative;
    width: 64px;
    height: 64px;
  `,
  sparklesIcon: css`
    font-size: 40px;
    color: ${cssVar.colorText};
  `,
  title: css`
    font-size: ${cssVar.fontSizeLG};
    font-weight: 500;
  `,
}));

const EmptyState = memo<{ provider: string }>(({ provider }) => {
  const { t } = useTranslation('modelProvider');
  const { message } = App.useApp();

  const [fetchRemoteModelList] = useAiInfraStore((s) => [s.fetchRemoteModelList]);

  const [fetchRemoteModelsLoading, setFetchRemoteModelsLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);

  return (
    <Center className={styles.container} gap={24} paddingBlock={40}>
      <Center className={styles.circle}>
        <Icon className={styles.sparklesIcon} icon={BrainIcon} />
      </Center>
      <Flexbox align={'center'} gap={8}>
        <div className={styles.title}>{t('providerModels.list.empty.title')}</div>
        <div className={styles.description}>{t('providerModels.list.empty.desc')}</div>
      </Flexbox>

      <Flexbox horizontal gap={8}>
        <Button
          icon={PlusIcon}
          onClick={() => {
            setShowModal(true);
          }}
        >
          {t('providerModels.list.addNew')}
        </Button>
        <CreateNewModelModal open={showModal} setOpen={setShowModal} />
        <Button
          icon={<Icon icon={LucideRefreshCcwDot} />}
          loading={fetchRemoteModelsLoading}
          type={'primary'}
          onClick={async () => {
            setFetchRemoteModelsLoading(true);
            try {
              await fetchRemoteModelList(provider);
            } catch (e) {
              message.error(
                e instanceof DOMException && e.name === 'TimeoutError'
                  ? t('providerModels.list.fetcher.timeout')
                  : e instanceof Error
                    ? e.message
                    : t('providerModels.list.fetcher.failed'),
              );
            } finally {
              setFetchRemoteModelsLoading(false);
            }
          }}
        >
          {fetchRemoteModelsLoading
            ? t('providerModels.list.fetcher.fetching')
            : t('providerModels.list.fetcher.fetch')}
        </Button>
      </Flexbox>
    </Center>
  );
});

export default EmptyState;
