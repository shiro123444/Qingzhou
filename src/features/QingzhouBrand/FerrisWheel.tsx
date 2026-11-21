'use client';

import { memo, useEffect, useRef, useState } from 'react';

import { styles } from './style';

/** A quiet watercolor/celadon scene: fixed supports, a slow rotor and eight upright sprites. */
export const QingzhouFerrisWheel = memo(
  ({ variant = 'home' }: { variant?: 'home' | 'presentation' }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [moving, setMoving] = useState(false);

    useEffect(() => {
      const node = ref.current;
      if (!node) return;
      let inView = true;
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      const sync = () =>
        setMoving(inView && document.visibilityState === 'visible' && !preference.matches);
      const observer =
        typeof IntersectionObserver === 'undefined'
          ? undefined
          : new IntersectionObserver(([entry]) => {
              inView = entry.isIntersecting;
              sync();
            });
      observer?.observe(node);
      preference.addEventListener('change', sync);
      document.addEventListener('visibilitychange', sync);
      sync();
      return () => {
        observer?.disconnect();
        preference.removeEventListener('change', sync);
        document.removeEventListener('visibilitychange', sync);
      };
    }, []);

    return (
      <div
        data-qz-ferris
        aria-hidden="true"
        className={styles.ferris}
        data-moving={moving}
        data-variant={variant}
        ref={ref}
      >
        <img
          alt=""
          className={styles.wheelWash}
          draggable={false}
          height={412}
          src="/brand/qingzhou-celadon/wash.webp"
          width={1024}
        />
        <div className={styles.rotor} data-qz-wheel="rotor">
          <svg
            fill="none"
            focusable="false"
            stroke="#a5beb4"
            strokeLinecap="round"
            viewBox="0 0 640 680"
          >
            <circle cx="320" cy="272" r="218" strokeWidth="7" />
            <circle cx="320" cy="272" opacity=".5" r="218" stroke="#e4ece2" strokeWidth="1.2" />
            {Array.from({ length: 8 }, (_, i) => {
              const angle = (i * Math.PI) / 4 - Math.PI / 2;
              return (
                <path
                  d={`M320 272L${320 + Math.cos(angle) * 218} ${272 + Math.sin(angle) * 218}`}
                  key={i}
                  opacity=".72"
                  strokeWidth="4"
                />
              );
            })}
          </svg>
          {Array.from({ length: 8 }, (_, i) => {
            const angle = (i * Math.PI) / 4 - Math.PI / 2;
            return (
              <span
                className={styles.cabinAnchor}
                key={i}
                style={{
                  left: `${((320 + Math.cos(angle) * 218) / 640) * 100}%`,
                  top: `${((272 + Math.sin(angle) * 218) / 680) * 100}%`,
                }}
              >
                <img
                  alt=""
                  className={styles.cabin}
                  data-qz-wheel="cabin"
                  draggable={false}
                  height={175}
                  src="/brand/qingzhou-celadon/cabin.webp"
                  width={192}
                />
              </span>
            );
          })}
        </div>
        <svg data-qz-wheel="support" fill="#a5beb4" focusable="false" viewBox="0 0 640 680">
          <path d="M310 272Q288 332 176 594Q173 602 185 602H199L320 306L441 602H455Q467 602 464 594Q352 332 330 272Z" />
          <circle cx="320" cy="272" fill="#adc4b7" r="23" />
          <circle cx="314" cy="265" fill="#edf1e8" opacity=".35" r="9" />
        </svg>
      </div>
    );
  },
);

QingzhouFerrisWheel.displayName = 'QingzhouFerrisWheel';
