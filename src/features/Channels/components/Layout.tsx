'use client';

import { Button, Flexbox } from '@lobehub/ui';
import { Drawer } from 'antd';
import { Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router-dom';

import { useIsMobile } from '@/hooks/useIsMobile';

import { styles } from '../styles';
import ChannelSidebar, { ChannelSidebarBody } from './Sidebar';

export default function ChannelsLayout() {
  const mobile = useIsMobile();
  const { pathname } = useLocation();
  const { t } = useTranslation('common');
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => setNavigationOpen(false), [pathname]);
  return (
    <>
      <ChannelSidebar />
      <Flexbox className={styles.main} flex={1}>
        {mobile && (
          <Flexbox padding={8}>
            <Button icon={Menu} onClick={() => setNavigationOpen(true)}>
              {t('channels.title')}
            </Button>
          </Flexbox>
        )}
        <Outlet />
      </Flexbox>
      {mobile && (
        <Drawer
          open={navigationOpen}
          placement="left"
          size={300}
          title={t('channels.title')}
          onClose={() => setNavigationOpen(false)}
        >
          <ChannelSidebarBody />
        </Drawer>
      )}
    </>
  );
}
