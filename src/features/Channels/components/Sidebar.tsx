'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Bot, Radio } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import { NavPanelPortal } from '@/features/NavPanel';
import BackNav from '@/features/NavPanel/components/BackNav';
import NavItem from '@/features/NavPanel/components/NavItem';
import SideBarLayout from '@/features/NavPanel/SideBarLayout';

import {
  CHANNEL_PLATFORMS,
  CHANNEL_SECTIONS,
  channelPath,
  matchesPlatform,
  PLATFORM_ICONS,
  SECTION_ICONS,
} from '../constants';
import { useChannelProviders } from '../data';
import { styles } from '../styles';

export function ChannelSidebarBody() {
  const { t } = useTranslation('common');
  const { platform, providerId, section } = useParams();
  const { data: providers = [] } = useChannelProviders();
  return (
    <Flexbox gap={2} padding={4}>
      <Link className={styles.link} to="/channels">
        <NavItem active={!platform} icon={Radio} title={t('channels.overview')} />
      </Link>
      <Text className={styles.muted} style={{ padding: '12px 8px 4px' }}>
        {t('channels.platform')}
      </Text>
      {CHANNEL_PLATFORMS.map((id) => (
        <div key={id}>
          <Link className={styles.link} to={`/channels/${id}`}>
            <NavItem
              active={platform === id && !providerId}
              icon={PLATFORM_ICONS[id]}
              title={t(`channels.platforms.${id}`)}
              extra={
                <Text className={styles.muted}>
                  {providers.filter((provider) => matchesPlatform(provider.platform, id)).length}
                </Text>
              }
            />
          </Link>
          {platform === id &&
            providers
              .filter((provider) => matchesPlatform(provider.platform, id))
              .map((provider) => (
                <div key={provider.id} style={{ paddingInlineStart: 12 }}>
                  <Link className={styles.link} to={channelPath(provider.platform, provider.id)}>
                    <NavItem
                      active={providerId === provider.id && !section}
                      icon={Bot}
                      iconSize={16}
                      title={provider.agentTitle || provider.applicationId}
                    />
                  </Link>
                  {providerId === provider.id &&
                    CHANNEL_SECTIONS.map((value) => (
                      <Link
                        className={styles.link}
                        key={value}
                        style={{ display: 'block', paddingInlineStart: 16 }}
                        to={channelPath(provider.platform, provider.id, value)}
                      >
                        <NavItem
                          active={section === value}
                          icon={SECTION_ICONS[value]}
                          iconSize={15}
                          title={t(`channels.sections.${value}`)}
                        />
                      </Link>
                    ))}
                </div>
              ))}
        </div>
      ))}
      <Text className={styles.muted} style={{ padding: '16px 8px 4px' }}>
        {t('channels.more')}
      </Text>
      <Link className={styles.link} to="/settings/bot-delivery">
        <NavItem icon={SECTION_ICONS.activity} title={t('channels.delivery')} />
      </Link>
    </Flexbox>
  );
}

const SidebarHeader = memo(() => {
  const { t } = useTranslation('common');
  return (
    <Flexbox padding={8}>
      <BackNav>
        <Radio size={18} />
        <Text fontSize={15} weight={600}>
          {t('channels.title')}
        </Text>
      </BackNav>
    </Flexbox>
  );
});

export default function ChannelSidebar() {
  return (
    <NavPanelPortal navKey="channels">
      <SideBarLayout body={<ChannelSidebarBody />} header={<SidebarHeader />} />
    </NavPanelPortal>
  );
}
