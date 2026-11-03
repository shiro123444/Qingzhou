'use client';

import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router-dom';

import CreateBot from '../components/CreateBot';
import { ChannelPage, LoadError, LoadingState, NoProviders } from '../components/Page';
import ProviderTable from '../components/ProviderTable';
import { isChannelPlatform, matchesPlatform } from '../constants';
import { useChannelProviders } from '../data';

export default function ChannelPlatformPage() {
  const { t } = useTranslation('common');
  const { platform } = useParams();
  const providers = useChannelProviders();
  if (!isChannelPlatform(platform)) return <Navigate replace to="/channels" />;
  const title = t(`channels.platforms.${platform}`);
  const matching = (providers.data ?? []).filter((provider) =>
    matchesPlatform(provider.platform, platform),
  );
  return (
    <ChannelPage
      actions={<CreateBot platform={platform} />}
      crumbs={[{ label: title }]}
      title={title}
    >
      {providers.isLoading ? (
        <LoadingState />
      ) : providers.error ? (
        <LoadError retry={() => void providers.mutate()} />
      ) : matching.length ? (
        <ProviderTable providers={matching} />
      ) : (
        <NoProviders />
      )}
    </ChannelPage>
  );
}
