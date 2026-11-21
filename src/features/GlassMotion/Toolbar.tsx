import { Tooltip } from 'antd';
import { cx } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { glassSurface } from '@/styles/liquidGlass';

import { glyphForIcon, MotionGlyph } from './MotionGlyph';
import { springs, toolbarTransitions } from './springs';
import { styles } from './style';

export interface GlassTool {
  active?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  id: string;
  label: string;
  onClick: () => void;
}

/** Accessible toolbar with the reference's independently sprung tooltip edges. */
export function GlassToolbar({
  label,
  items,
  portalTips = false,
}: {
  label: string;
  items: GlassTool[];
  portalTips?: boolean;
}) {
  const reduced = useReducedMotion(),
    id = useId();
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hovered, setHovered] = useState<string>();
  const left = useMotionValue(0),
    right = useMotionValue(100);
  const width = useTransform([left, right], ([a, b]) => Math.max(32, Number(b) - Number(a)));
  const edges = useRef<{ stop: () => void }[]>([]);
  const show = (item: GlassTool, button: HTMLButtonElement) => {
    clearTimeout(timer.current);
    const bounds = button.getBoundingClientRect(),
      parent = root.current!.getBoundingClientRect();
    const nextWidth = Math.max(92, item.label.length * 13 + 24);
    const nextLeft = Math.max(
      12 - parent.left,
      Math.min(
        window.innerWidth - parent.left - nextWidth - 12,
        bounds.left - parent.left + bounds.width / 2 - nextWidth / 2,
      ),
    );
    edges.current.forEach((edge) => edge.stop());
    if (reduced || !hovered) {
      left.jump(nextLeft);
      right.jump(nextLeft + nextWidth);
    } else {
      const forward = nextLeft > left.get();
      edges.current = [
        animate(left, nextLeft, { type: 'spring', ...(forward ? springs.trail : springs.lead) }),
        animate(right, nextLeft + nextWidth, {
          type: 'spring',
          ...(forward ? springs.lead : springs.trail),
        }),
      ];
    }
    setHovered(item.id);
  };
  const hide = () => {
    timer.current = setTimeout(() => setHovered(undefined), 140);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      edges.current.forEach((edge) => edge.stop());
    },
    [],
  );
  const current = items.find((item) => item.id === hovered);
  return (
    <motion.div
      aria-label={label}
      className={cx(glassSurface, styles.toolbar)}
      data-qz-glass="capsule"
      layout={!reduced}
      ref={root}
      role="toolbar"
      transition={
        reduced
          ? { duration: 0 }
          : portalTips
            ? { type: 'spring', ...springs.soft }
            : toolbarTransitions.reflow
      }
      onMouseLeave={hide}
    >
      {items.map((item) => {
        const button = (
          <button
            aria-describedby={hovered === item.id ? `${id}-tip` : undefined}
            aria-label={item.label}
            aria-pressed={item.active}
            className={styles.tool}
            disabled={item.disabled}
            key={item.id}
            type="button"
            onBlur={hide}
            onClick={item.onClick}
            onFocus={portalTips ? undefined : (event) => show(item, event.currentTarget)}
            onMouseEnter={portalTips ? undefined : (event) => show(item, event.currentTarget)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const buttons = [
                ...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              ];
              const index = buttons.indexOf(event.currentTarget);
              buttons[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
                      buttons.length
              ]?.focus();
            }}
          >
            {item.active && (
              <motion.span
                className={styles.plate}
                layoutId={`${id}-plate`}
                transition={
                  reduced
                    ? { duration: 0 }
                    : portalTips
                      ? { type: 'spring', ...springs.soft }
                      : toolbarTransitions.plate
                }
              />
            )}
            {glyphForIcon(item.icon) ? (
              <MotionGlyph active={item.active} name={glyphForIcon(item.icon)!} size={18} />
            ) : (
              <item.icon aria-hidden size={18} strokeWidth={1.7} />
            )}
          </button>
        );
        return portalTips ? (
          <Tooltip
            key={item.id}
            arrow={false}
            title={item.label}
            trigger={['hover', 'focus']}
            placement="bottom"
            destroyOnHidden
          >
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
      <AnimatePresence>
        {current && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className={styles.tooltip}
            exit={{ opacity: 0, y: 3 }}
            id={`${id}-tip`}
            initial={{ opacity: 0, y: 5 }}
            role="tooltip"
            style={{ left, width }}
            transition={reduced ? { duration: 0 } : { type: 'spring', ...springs.fade }}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, x: -14, filter: 'blur(3px)' }}
                initial={{ opacity: 0, x: 14, filter: 'blur(3px)' }}
                key={current.id}
                transition={reduced ? { duration: 0 } : { type: 'spring', ...springs.fade }}
              >
                {current.label}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
