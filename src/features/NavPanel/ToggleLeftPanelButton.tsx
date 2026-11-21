'use client';

import { HotkeyEnum } from '@lobechat/const/hotkeys';
import { type ActionIconProps } from '@lobehub/ui';
import { type ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PanelToggle } from '@/features/GlassMotion/PanelToggle';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

export const SIDEBAR_PANEL_ID = 'qz-sidebar';

interface ToggleLeftPanelButtonProps {
  icon?: ActionIconProps['icon'];
  showActive?: boolean;
  size?: ActionIconProps['size'];
  title?: ReactNode;
}

const ToggleLeftPanelButton = memo<ToggleLeftPanelButtonProps>(
  ({ title, showActive, icon, size }) => {
    const [expand, togglePanel] = useGlobalStore((s) => [
      systemStatusSelectors.showLeftPanel(s),
      s.toggleLeftPanel,
    ]);
    const hotkey = useUserStore(settingsSelectors.getHotkeyById(HotkeyEnum.ToggleLeftPanel));

    const { t } = useTranslation(['chat', 'hotkey']);
    const action = t(expand ? 'toggleLeftPanel.collapse' : 'toggleLeftPanel.expand', {
      ns: 'hotkey',
    });
    const toggle = () => {
      const focused = document.activeElement;
      togglePanel();
      requestAnimationFrame(() => {
        if (
          focused instanceof HTMLElement &&
          focused.matches('[data-sidebar-toggle]') &&
          (!focused.isConnected || focused.closest('[inert]'))
        ) {
          [...document.querySelectorAll<HTMLElement>('[data-sidebar-toggle]')]
            .find((button) => !button.closest('[inert]') && button.getClientRects().length)
            ?.focus({ preventScroll: true });
        }
      });
    };

    return (
      <PanelToggle
        data-sidebar-toggle
        active={showActive ? expand : undefined}
        aria-controls={SIDEBAR_PANEL_ID}
        expanded={Boolean(expand)}
        side="left"
        label={typeof title === 'string' ? title : action}
        size={size || { blockSize: 32, borderRadius: 10, size: 18 }}
        title={title || action}
        icon={icon}
        tooltipProps={{
          hotkey,
          placement: 'bottom',
        }}
        onToggle={toggle}
      />
    );
  },
);

export const SidebarReopenButton = memo(() => {
  const expand = useGlobalStore(systemStatusSelectors.showLeftPanel);
  return expand ? null : <ToggleLeftPanelButton />;
});

export default ToggleLeftPanelButton;
