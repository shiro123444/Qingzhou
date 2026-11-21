import { memo, useCallback, useId, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { PanelToggle } from '@/features/GlassMotion/PanelToggle';
import { panelMotionStyle } from '@/features/GlassMotion/panelMotion';
import { useRuntimeStore } from '@/store/runtime';

import { RunItem } from './RunItem';
import { styles } from './style';

export interface SidebarProps {
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export const Sidebar = memo<SidebarProps>(({ defaultCollapsed = false, onCollapsedChange }) => {
  const id = useId();
  const { t } = useTranslation('hotkey');
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const runs = useRuntimeStore((s) => s.runs);
  const activeRunId = useRuntimeStore((s) => s.activeRunId);
  const setActiveRunId = useRuntimeStore((s) => s.setActiveRunId);

  const runList = Object.values(runs);

  const handleToggle = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      onCollapsedChange?.(next);
    },
    [onCollapsedChange],
  );

  return (
    <aside
      className={collapsed ? `${styles.sidebar} ${styles.sidebarCollapsed}` : styles.sidebar}
      data-collapsed={collapsed ? 'true' : 'false'}
      style={panelMotionStyle}
      data-testid="workspace-sidebar"
    >
      <div className={collapsed ? styles.collapsedBar : styles.header}>
        {!collapsed && <span>Runs ({runList.length})</span>}
        <PanelToggle
          side="left"
          expanded={!collapsed}
          aria-controls={id}
          data-testid={
            collapsed ? 'workspace-sidebar-expand-btn' : 'workspace-sidebar-collapse-btn'
          }
          label={
            collapsed
              ? t('toggleLeftPanel.expand', '展开侧栏')
              : t('toggleLeftPanel.collapse', '收起侧栏')
          }
          size={{ blockSize: 44, size: 18, borderRadius: 12 }}
          onToggle={() => handleToggle(!collapsed)}
        />
      </div>
      <div id={id} hidden={collapsed} className={!collapsed ? styles.list : undefined}>
        {runList.length === 0 ? (
          <div className={styles.empty}>No runs recorded</div>
        ) : (
          runList.map((run) => (
            <RunItem
              isActive={run.runId === activeRunId}
              key={run.runId}
              run={run}
              onSelect={setActiveRunId}
            />
          ))
        )}
      </div>
    </aside>
  );
});

Sidebar.displayName = 'WorkspaceSidebar';

export default Sidebar;
