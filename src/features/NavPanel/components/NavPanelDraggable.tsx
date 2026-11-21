'use client';

import { DraggablePanel } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { type ReactNode } from 'react';
import { memo, Suspense, useEffect, useRef } from 'react';

import { springs } from '@/features/GlassMotion/springs';
import { SIDEBAR_PANEL_ID } from '@/features/NavPanel/ToggleLeftPanelButton';
import { useIsMobile } from '@/hooks/useIsMobile';
import Footer from '@/routes/(main)/home/_layout/Footer';
import { USER_DROPDOWN_ICON_ID } from '@/routes/(main)/home/_layout/Header/components/User';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { glassSurface } from '@/styles/liquidGlass';

import { useNavPanelSizeChangeHandler } from '../hooks/useNavPanel';
import { SidebarMotionContext } from '../SidebarMotionContext';
import { BACK_BUTTON_ID } from './BackButton';

const draggableStyles = createStaticStyles(({ css, cssVar }) => ({
  content: css`
    position: relative;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    height: 100%;
    min-height: 100%;
    max-height: 100%;
  `,
  inner: css`
    position: relative;

    overflow: hidden;
    flex: 1;

    min-width: 0;
    max-width: 100%;
    min-height: 0;
  `,
  layer: css`
    position: absolute;
    inset: 0;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    min-width: 0;
    max-width: 100%;
    min-height: 100%;
    max-height: 100%;
  `,
  panel: css`
    user-select: none;
    height: 100%;
    color: ${cssVar.colorTextSecondary};
    background: transparent;

    * {
      user-select: none;
    }

    #${USER_DROPDOWN_ICON_ID} {
      width: 0 !important;
      opacity: 0;
      transition:
        opacity,
        width 0.2s ${cssVar.motionEaseOut};
    }
    #${BACK_BUTTON_ID} {
      width: 24px !important;
    }

    &:hover {
      #${USER_DROPDOWN_ICON_ID} {
        width: 14px !important;
        opacity: 1;
      }
    }
  `,
  surface: css`
    width: calc(100% - 16px);
    height: calc(100% - 16px);
    min-height: calc(100% - 16px);
    max-height: calc(100% - 16px);
    margin: 8px;
    border-radius: var(--qz-glass-radius-shell, 20px);
  `,
}));

interface NavPanelDraggableProps {
  activeContent: {
    key: string;
    node: ReactNode;
  };
}

const classNames = {
  content: draggableStyles.content,
};

export const NavPanelDraggable = memo<NavPanelDraggableProps>(({ activeContent }) => {
  const workspaceDrawerMode = useIsMobile() && activeContent.key === 'channels';
  const [expand, togglePanel, isStatusInit] = useGlobalStore((s) => [
    systemStatusSelectors.showLeftPanel(s),
    s.toggleLeftPanel,
    systemStatusSelectors.isStatusInit(s),
  ]);
  const savedWidth = useGlobalStore(systemStatusSelectors.leftPanelWidth);
  const reduced = useReducedMotion();
  const visible = !!expand && !workspaceDrawerMode;
  const width = useSpring(visible ? savedWidth : 0, springs.soft);
  const renderedWidth = useTransform(width, (value) => Math.max(0, value));
  const handleSizeChange = useNavPanelSizeChangeHandler((next) => width.jump(next));
  useEffect(() => {
    if (reduced || !isStatusInit) width.jump(visible ? savedWidth : 0);
    else width.set(visible ? savedWidth : 0);
  }, [visible, savedWidth, reduced, isStatusInit, width]);

  // Defer DraggablePanel mount until system status hydrates; otherwise defaultSize
  // captures the pre-hydration default and the DOM drifts off NavigationBar's live width.
  const defaultWidthRef = useRef(0);
  if (defaultWidthRef.current === 0 && isStatusInit) {
    defaultWidthRef.current = systemStatusSelectors.leftPanelWidth(useGlobalStore.getState());
  }

  if (defaultWidthRef.current === 0) {
    const pendingWidth = systemStatusSelectors.leftPanelWidth(useGlobalStore.getState());
    return <div aria-hidden style={{ flexShrink: 0, height: '100%', width: pendingWidth }} />;
  }

  const defaultSize = { height: '100%', width: defaultWidthRef.current };

  return (
    <SidebarMotionContext value={visible}>
      <motion.div
        data-sidebar-motion
        style={{ width: renderedWidth, height: '100%', flexShrink: 0, overflow: 'hidden' }}
      >
        <DraggablePanel
          expand
          className={draggableStyles.panel}
          classNames={classNames}
          defaultSize={defaultSize}
          expandable={false}
          maxWidth={400}
          minWidth={240}
          placement="left"
          resize={visible ? undefined : false}
          showBorder={false}
          style={{ background: 'transparent', zIndex: 11 }}
          onExpandChange={togglePanel}
          onSizeDragging={handleSizeChange}
        >
          <div
            aria-hidden={!expand || workspaceDrawerMode}
            className={cx(glassSurface, draggableStyles.content, draggableStyles.surface)}
            data-qz-glass="sidebar"
            id={SIDEBAR_PANEL_ID}
            inert={!expand || workspaceDrawerMode}
          >
            <div className={draggableStyles.inner}>
              <div className={draggableStyles.layer} key={activeContent.key}>
                {activeContent.node}
              </div>
            </div>
            <Suspense>
              <Footer />
            </Suspense>
          </div>
        </DraggablePanel>
      </motion.div>
    </SidebarMotionContext>
  );
});
