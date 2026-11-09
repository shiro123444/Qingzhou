'use client';

import { Button, Skeleton } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

import { useMusicActivation } from '@/features/MusicPlayer/session-context';
import MusicStudio from '@/features/MusicStudio';
import { NavPanelPortal } from '@/features/NavPanel';
import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';
import SidebarContent from '@/routes/(main)/home/_layout/SidebarContent';

/** Keep music in the shared workspace navigation without remounting the player host. */
export default function MusicWorkspace() {
  const { ready, error, retry } = useMusicActivation();
  const { t } = useTranslation('music');
  return (
    <>
      <NavPanelPortal navKey="home">
        <SidebarContent />
      </NavPanelPortal>
      {ready ? (
        <MusicStudio navigation={<ToggleLeftPanelButton />} />
      ) : error ? (
        <Button onClick={retry}>{t('retry')}</Button>
      ) : (
        <Skeleton active />
      )}
    </>
  );
}
