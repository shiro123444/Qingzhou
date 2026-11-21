import { ActionIcon, type ActionIconProps } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { motion, useReducedMotion } from 'motion/react';

import { MotionGlyph } from './MotionGlyph';
import { springs } from './springs';

const styles = createStaticStyles(({ css, cssVar }) => ({
  trigger: css`
    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillQuaternary};

    &:hover,
    &:focus-visible {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: -2px;
    }
  `,
}));

export function PanelGlyph({ side, expanded }: { side: 'left' | 'right'; expanded: boolean }) {
  const reduced = useReducedMotion();
  return (
    <span
      aria-hidden
      style={{ display: 'flex', transform: side === 'right' ? 'scaleX(-1)' : undefined }}
    >
      <motion.span
        animate={{ scaleX: expanded ? 1 : 0.77 }}
        initial={false}
        style={{ display: 'flex', transformOrigin: 'left center' }}
        transition={reduced ? { duration: 0 } : { type: 'spring', ...springs.sidebarToggle }}
      >
        <MotionGlyph active={expanded} name="sidebar" size={18} />
      </motion.span>
    </span>
  );
}

type PanelToggleProps = Omit<ActionIconProps, 'onClick'> & {
  expanded: boolean;
  label: string;
  onToggle: () => void;
  side: 'left' | 'right';
};

/** Visibility remains owned by each workspace; only the disclosure interaction is shared. */
export function PanelToggle({
  expanded,
  side,
  label,
  onToggle,
  className,
  title,
  icon,
  size,
  ...rest
}: PanelToggleProps) {
  return (
    <ActionIcon
      {...rest}
      aria-expanded={expanded}
      aria-label={label}
      className={cx(styles.trigger, className)}
      data-panel-toggle={side}
      icon={icon ?? <PanelGlyph expanded={expanded} side={side} />}
      size={size ?? { blockSize: 32, borderRadius: 10, size: 18 }}
      title={title ?? label}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (!event.repeat && !rest.disabled) onToggle();
        }
      }}
    />
  );
}
