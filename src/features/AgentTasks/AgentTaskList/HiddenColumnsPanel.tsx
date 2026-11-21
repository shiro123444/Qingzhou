import type { TaskStatus } from '@lobechat/types';
import { Text } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';

import { PanelGlyph } from '@/features/GlassMotion/PanelToggle';
import { panelMotionStyle } from '@/features/GlassMotion/panelMotion';

import TaskStatusIcon from '../features/TaskStatusIcon';

export const HIDDEN_PANEL_WIDTH = {
  collapsed: 36,
  expanded: 220,
};

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    cursor: pointer;

    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    transition: border-color 0.2s;

    &:hover {
      border-color: ${cssVar.colorPrimaryBorder};
    }
  `,
  collapsedHeader: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;

    padding-block: 12px;
    padding-inline: 6px;

    color: ${cssVar.colorTextSecondary};
  `,
  count: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
  `,
  header: css`
    cursor: pointer;

    display: flex;
    gap: 6px;
    align-items: center;

    padding-block: 10px 8px;
    padding-inline: 6px;

    color: ${cssVar.colorTextSecondary};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 4px 12px;
    padding-inline: 2px;
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;

    overflow: hidden auto;
    transition: width var(--qz-panel-resize);
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
    > button {
      border: 0;
      background: transparent;
      font: inherit;
    }
    > button:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
    max-height: 100%;
    margin-inline-start: auto;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  verticalLabel: css`
    writing-mode: vertical-rl;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
  `,
}));

interface HiddenColumn {
  columnKey: string;
  label: string;
  statusIcon?: TaskStatus;
  total: number;
}

interface HiddenColumnsPanelProps {
  collapsed: boolean;
  columns: HiddenColumn[];
  onRestore: (columnKey: string) => void;
  onToggleCollapsed: (next: boolean) => void;
}

const HiddenColumnsPanel = memo<HiddenColumnsPanelProps>(
  ({ collapsed, columns, onRestore, onToggleCollapsed }) => {
    const { t } = useTranslation('chat');

    const listId = useId();
    if (columns.length === 0) return null;

    const title = t('taskList.kanban.hiddenColumns');

    return (
      <div
        className={styles.panel}
        style={{
          ...panelMotionStyle,
          width: collapsed ? HIDDEN_PANEL_WIDTH.collapsed : HIDDEN_PANEL_WIDTH.expanded,
        }}
      >
        <button
          aria-controls={listId}
          aria-expanded={!collapsed}
          className={collapsed ? styles.collapsedHeader : styles.header}
          title={title}
          type="button"
          onClick={() => onToggleCollapsed(!collapsed)}
        >
          <PanelGlyph expanded={!collapsed} side="right" />
          <Text className={collapsed ? styles.verticalLabel : undefined} fontSize={13}>
            {title}
          </Text>
          {!collapsed && (
            <Text className={styles.count} fontSize={12}>
              {columns.length}
            </Text>
          )}
        </button>
        <div id={listId} hidden={collapsed} className={collapsed ? undefined : styles.list}>
          {columns.map((column) => (
            <div
              className={cx(styles.card)}
              key={column.columnKey}
              title={t('taskList.kanban.showColumn')}
              onClick={() => onRestore(column.columnKey)}
            >
              {column.statusIcon && <TaskStatusIcon size={16} status={column.statusIcon} />}
              <Text fontSize={13}>{column.label}</Text>
              <Text className={styles.count} fontSize={12}>
                {column.total}
              </Text>
            </div>
          ))}
        </div>
      </div>
    );
  },
);

export default HiddenColumnsPanel;
