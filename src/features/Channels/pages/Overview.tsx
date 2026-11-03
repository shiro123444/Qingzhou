'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import CreateBot from '../components/CreateBot';
import { ChannelPage, LoadError, LoadingState, NoProviders } from '../components/Page';
import ProviderTable from '../components/ProviderTable';
import { CHANNEL_PLATFORMS, matchesPlatform, PLATFORM_ICONS } from '../constants';
import { useChannelProviders } from '../data';
import { styles } from '../styles';

export default function ChannelOverview() {
  const { t } = useTranslation('common');
  const providers = useChannelProviders();
  return (
    <ChannelPage actions={<CreateBot />} title={t('channels.title')}>
      {providers.isLoading ? (
        <LoadingState />
      ) : providers.error ? (
        <LoadError retry={() => void providers.mutate()} />
      ) : (
        <>
          <div className={styles.grid}>
            {CHANNEL_PLATFORMS.map((platform) => {
              const bots = (providers.data ?? []).filter((provider) =>
                matchesPlatform(provider.platform, platform),
              );
              return (
                <Link className={styles.link} key={platform} to={`/channels/${platform}`}>
                  <Flexbox className={styles.panel} gap={18}>
                    <Flexbox horizontal align="center" justify="space-between">
                      <Flexbox horizontal align="center" gap={10}>
                        <Icon icon={PLATFORM_ICONS[platform]} />
                        <Text weight={600}>{t(`channels.platforms.${platform}`)}</Text>
                      </Flexbox>
                      <Icon icon={ChevronRight} size={16} />
                    </Flexbox>
                    <Flexbox horizontal align="baseline" gap={8}>
                      <span className={styles.stat}>{bots.length}</span>
                      <Text type="secondary">{t('channels.botCount')}</Text>
                    </Flexbox>
                    <Text className={styles.muted}>
                      {t('channels.connectedCount', {
                        count: bots.filter(
                          (provider) =>
                            provider.enabled && provider.runtimeStatus.status === 'connected',
                        ).length,
                      })}
                    </Text>
                  </Flexbox>
                </Link>
              );
            })}
          </div>
          <section className={styles.section}>
            <Flexbox horizontal align="center" justify="space-between" paddingBlock={12}>
              <Text weight={600}>{t('channels.allBots')}</Text>
              <Text className={styles.muted}>{providers.data?.length ?? 0}</Text>
            </Flexbox>
            {providers.data?.length ? (
              <ProviderTable providers={providers.data} />
            ) : (
              <NoProviders />
            )}
          </section>
        </>
      )}
    </ChannelPage>
  );
}
