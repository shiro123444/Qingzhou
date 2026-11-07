'use client';

import MusicStudio from '@/features/MusicStudio';
import { NavPanelPortal } from '@/features/NavPanel';
import ToggleLeftPanelButton from '@/features/NavPanel/ToggleLeftPanelButton';
import SidebarContent from '@/routes/(main)/home/_layout/SidebarContent';

/** Keep music in the shared workspace navigation without remounting the player host. */
export default function MusicWorkspace() {
  return (
    <>
      <NavPanelPortal navKey="home">
        <SidebarContent />
      </NavPanelPortal>
      <MusicStudio navigation={<ToggleLeftPanelButton />} />
    </>
  );
}
