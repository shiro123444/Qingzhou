'use client';

import { type BlockProps, type GenericItemType, type IconProps } from '@lobehub/ui';
import { Block, Center, ContextMenuTrigger, Flexbox, Icon, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode } from 'react';
import { memo, use } from 'react';

import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { glyphForIcon, MotionGlyph } from '@/features/GlassMotion/MotionGlyph';
import { springs } from '@/features/GlassMotion/springs';
import { WeightWave } from '@/features/GlassMotion/WeightWave';
import { isModifierClick } from '@/utils/navigation';

import { SidebarMotionContext } from '../SidebarMotionContext';

const ACTION_CLASS_NAME = 'nav-item-actions';

const styles = createStaticStyles(({ css }) => ({
  active: css`
    && {
      background: var(--qz-glass-selection, ${cssVar.colorFillSecondary});
    }
  `,
  container: css`
    user-select: none;
    overflow: hidden;
    min-width: 32px;
    border-radius: var(--qz-glass-radius-item, ${cssVar.borderRadius});

    .${ACTION_CLASS_NAME} {
      width: 0;
      margin-inline-end: 2px;
      opacity: 0;
      transition: opacity 0.2s ${cssVar.motionEaseOut};

      &:has([data-popup-open]) {
        width: unset;
        opacity: 1;
      }
    }

    &:hover {
      .${ACTION_CLASS_NAME} {
        width: unset;
        opacity: 1;
      }
    }
  `,
}));

export interface NavItemSlots {
  iconPostfix?: ReactNode;
  titlePrefix?: ReactNode;
}

export interface NavItemProps extends Omit<BlockProps, 'children' | 'title'> {
  actions?: ReactNode;
  active?: boolean;
  contextMenuItems?: GenericItemType[] | (() => GenericItemType[]);
  disabled?: boolean;
  extra?: ReactNode;
  /**
   * Optional href for cmd+click to open in new tab
   */
  href?: string;
  icon?: IconProps['icon'];
  iconSize?: number;
  loading?: boolean;
  slots?: NavItemSlots;
  title: ReactNode;
}

const NavItem = memo<NavItemProps>(
  ({
    className,
    actions,
    contextMenuItems,
    active,
    href,
    icon,
    iconSize = 18,
    title,
    onClick,
    disabled,
    loading,
    extra,
    slots,
    ...rest
  }) => {
    const expanded = use(SidebarMotionContext),
      reduced = useReducedMotion();
    const iconColor = active ? cssVar.colorText : cssVar.colorTextDescription;
    const textColor = active ? cssVar.colorText : cssVar.colorTextSecondary;
    const variant = active ? 'filled' : 'borderless';
    const glyph = glyphForIcon(icon);

    const { titlePrefix, iconPostfix } = slots || {};
    // Link props for cmd+click support
    const linkProps = href
      ? {
          as: 'a' as const,
          href,
          style: { color: 'inherit', textDecoration: 'none' },
        }
      : {};

    const Content = (
      <Block
        data-kinetic-control
        horizontal
        align={'center'}
        aria-current={href && active ? 'page' : undefined}
        className={cx(styles.container, active && styles.active, className)}
        clickable={!disabled}
        gap={8}
        height={36}
        paddingInline={4}
        variant={variant}
        onClick={(e) => {
          // Always prevent default <a> navigation for normal clicks to avoid full page reload.
          // This must run before any early return to ensure SPA navigation is never bypassed.
          if (href && !isModifierClick(e)) {
            e.preventDefault();
          }
          if (disabled) return;
          onClick?.(e);
        }}
        {...linkProps}
        {...rest}
      >
        {icon && (
          <Center flex={'none'} height={28} width={28}>
            {loading ? (
              <NeuralNetworkLoading size={iconSize} />
            ) : glyph ? (
              <span style={{ color: iconColor }}>
                <MotionGlyph active={active} name={glyph} size={iconSize} />
              </span>
            ) : (
              <Icon color={iconColor} icon={icon} size={iconSize} />
            )}
          </Center>
        )}

        {iconPostfix}
        <Flexbox horizontal align={'center'} flex={1} gap={8} style={{ overflow: 'hidden' }}>
          {titlePrefix}
          <motion.div
            animate={{ opacity: expanded ? 1 : 0, x: expanded ? 0 : -8 }}
            initial={false}
            style={{ flex: 1, minWidth: 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : { type: 'spring', ...springs.sidebarLabel, delay: expanded ? 0.06 : 0 }
            }
          >
            <Text
              color={textColor}
              style={{ flex: 1 }}
              ellipsis={{
                tooltipWhenOverflow: true,
              }}
            >
              {typeof title === 'string' ? (
                <WeightWave weight={active ? 600 : 450}>{title}</WeightWave>
              ) : (
                title
              )}
            </Text>
          </motion.div>
          <Flexbox
            horizontal
            align={'center'}
            gap={2}
            justify={'flex-end'}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {extra}
            {actions && (
              <Flexbox
                horizontal
                align={'center'}
                className={ACTION_CLASS_NAME}
                gap={2}
                justify={'flex-end'}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {actions}
              </Flexbox>
            )}
          </Flexbox>
        </Flexbox>
      </Block>
    );
    if (!contextMenuItems) return Content;
    return <ContextMenuTrigger items={contextMenuItems}>{Content}</ContextMenuTrigger>;
  },
);

export default NavItem;
