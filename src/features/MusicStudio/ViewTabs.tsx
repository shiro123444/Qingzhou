'use client';

import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { type GlyphName, MotionGlyph } from '@/features/GlassMotion/MotionGlyph';

import { styles } from './style';

const views = ['player', 'library', 'queue', 'plugins'] as const;
export type StudioView = (typeof views)[number];
const icons: Record<StudioView, GlyphName> = {
  library: 'library',
  player: 'music',
  plugins: 'plugins',
  queue: 'tasks',
};
const MOTION_MS = 580;

/** One persistent optical surface, including while an interrupted move changes direction. */
export default function ViewTabs({
  onChange,
  value,
}: {
  onChange: (value: StudioView) => void;
  value: StudioView;
}) {
  const { t } = useTranslation('music');
  const root = useRef<HTMLDivElement>(null);
  const drop = useRef<HTMLSpanElement>(null);
  const sheen = useRef<HTMLSpanElement>(null);
  const move = useRef<(animated: boolean) => void>(() => {});

  useLayoutEffect(() => {
    const container = root.current!;
    const surface = drop.current!;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    let reflection: Animation | undefined;
    let ready = false;
    const sync = (animated: boolean) => {
      const selected = container.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      const target = selected.getBoundingClientRect();
      if (!target.width || !target.height) return;
      const parent = container.getBoundingClientRect();
      const current = surface.getBoundingClientRect();
      const left = target.left - parent.left;
      const top = target.top - parent.top;
      const fromLeft = current.left - parent.left;
      const fromTop = current.top - parent.top;
      const distance = left - fromLeft;
      const transform = (x: number, y: number, width: number, height: number) =>
        `translate3d(${x}px, ${y}px, 0) scale(${width / target.width}, ${height / target.height})`;
      const final = transform(left, top, target.width, target.height);
      animation?.cancel();
      reflection?.cancel();
      // Animate transforms only: resizing the pane every frame would recapture the scene.
      Object.assign(surface.style, {
        height: `${target.height}px`,
        transform: final,
        visibility: 'visible',
        width: `${target.width}px`,
      });
      container.dataset.qzGlassMorphing = 'false';
      if (
        animated &&
        ready &&
        !preference.matches &&
        !document.hidden &&
        (Math.abs(distance) > 0.5 ||
          Math.abs(current.width - target.width) > 0.5 ||
          Math.abs(top - fromTop) > 0.5)
      ) {
        const stretch = Math.min(30, Math.abs(distance) * 0.16);
        const width = (current.width + target.width) / 2 + stretch;
        const center =
          (current.left + current.width / 2 + target.left + target.width / 2) / 2 - parent.left;
        animation = surface.animate(
          [
            { offset: 0, transform: transform(fromLeft, fromTop, current.width, current.height) },
            {
              offset: 0.38,
              transform: transform(
                center - width / 2,
                top + target.height * 0.03,
                width,
                target.height * 0.94,
              ),
            },
            {
              offset: 0.74,
              transform: transform(
                left - Math.sign(distance) * 3,
                top - 0.5,
                target.width + 3,
                target.height + 1,
              ),
            },
            { offset: 1, transform: final },
          ],
          { duration: MOTION_MS, easing: 'cubic-bezier(0.22, 0.8, 0.25, 1)' },
        );
        reflection = sheen.current?.animate(
          [
            { backgroundPosition: distance < 0 ? '100% 50%' : '0% 50%', opacity: 0.18 },
            { backgroundPosition: '50% 50%', opacity: 0.65, offset: 0.4 },
            { backgroundPosition: distance < 0 ? '0% 50%' : '100% 50%', opacity: 0.18 },
          ],
          { duration: MOTION_MS, easing: 'ease-out' },
        );
        container.dataset.qzGlassMorphing = 'true';
        animation.onfinish = () => {
          container.dataset.qzGlassMorphing = 'false';
        };
      }
      ready = true;
    };
    move.current = sync;
    const settle = () => sync(false);
    const visibility = () => {
      if (document.hidden) settle();
    };
    const observer = new ResizeObserver(settle);
    const locale = new MutationObserver(settle);
    locale.observe(document.documentElement, {
      attributeFilter: ['dir', 'lang'],
      attributes: true,
    });
    observer.observe(container);
    container.querySelectorAll('[role="tab"]').forEach((tab) => observer.observe(tab));
    preference.addEventListener('change', settle);
    document.addEventListener('visibilitychange', visibility);
    sync(false);
    return () => {
      animation?.cancel();
      reflection?.cancel();
      observer.disconnect();
      locale.disconnect();
      preference.removeEventListener('change', settle);
      document.removeEventListener('visibilitychange', visibility);
      move.current = () => {};
    };
  }, []);

  useLayoutEffect(() => move.current(true), [value]);

  return (
    <div
      data-qz-glass-motion
      aria-label={t('viewNavigation')}
      className={styles.tabs}
      ref={root}
      role="tablist"
    >
      <span
        aria-hidden
        data-music-view-droplet
        className={styles.tabDroplet}
        data-qz-glass="control"
        dir="ltr"
        ref={drop}
      >
        <span className={styles.tabSheen} ref={sheen} />
      </span>
      {views.map((item) => {
        const label = t(item === 'player' ? 'nowPlaying' : item);
        return (
          <button
            data-qz-glass-foreground
            aria-controls={'music-view-' + item}
            aria-label={label}
            aria-selected={value === item}
            className={styles.tab}
            id={'music-tab-' + item}
            key={item}
            role="tab"
            tabIndex={value === item ? 0 : -1}
            onClick={() => onChange(item)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const direction = getComputedStyle(root.current!).direction === 'rtl' ? -1 : 1;
              const index = views.indexOf(item);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? views.length - 1
                    : (index +
                        (event.key === 'ArrowRight' ? direction : -direction) +
                        views.length) %
                      views.length;
              onChange(views[next]);
              root.current?.querySelector<HTMLElement>('#music-tab-' + views[next])?.focus();
            }}
          >
            <MotionGlyph active={value === item} name={icons[item]} size={18} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
