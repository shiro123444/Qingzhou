'use client';

import { type CSSProperties, memo, useEffect, useId, useRef, useState } from 'react';

import { styles } from './style';

/** The frame is fixed; the ring rotates, cabins counter-rotate and gently settle. */
export const QingzhouFerrisWheel = memo(
  ({ variant = 'home' }: { variant?: 'home' | 'presentation' }) => {
    const id = useId().replaceAll(':', '');
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
        <svg fill="none" focusable="false" viewBox="0 0 640 680">
          <defs>
            <linearGradient
              gradientUnits="userSpaceOnUse"
              id={`${id}-steel`}
              x1="80"
              x2="550"
              y1="60"
              y2="560"
            >
              <stop stopColor="#659eb9" />
              <stop offset="1" stopColor="#76aaa0" />
            </linearGradient>
          </defs>
          <g stroke={`url(#${id}-steel)`} strokeLinecap="round" strokeLinejoin="round">
            <path d="M82 614H558 M112 625H528" opacity=".28" />
            <ellipse
              cx="320"
              cy="604"
              fill="currentColor"
              fillOpacity=".035"
              rx="155"
              ry="9"
              stroke="none"
            />
            <g className={styles.rotor} data-qz-wheel="rotor">
              <circle cx="320" cy="278" r="226" strokeWidth="3" />
              <circle cx="320" cy="278" r="215" strokeWidth="1.5" />
              <circle cx="320" cy="278" opacity=".5" r="146" />
              {Array.from({ length: 16 }, (_, i) => {
                const angle = (i * Math.PI) / 8 - Math.PI / 2;
                const next = angle + Math.PI / 8;
                const x = 320 + Math.cos(angle) * 226;
                const y = 278 + Math.sin(angle) * 226;
                const ix = 320 + Math.cos(next) * 146;
                const iy = 278 + Math.sin(next) * 146;
                return (
                  <g key={i}>
                    <path d={`M320 278L${x} ${y}L${ix} ${iy}`} opacity=".62" strokeWidth="1.3" />
                    <circle cx={x} cy={y} fill="var(--qz-wheel-surface)" r="3.5" />
                    <g transform={`translate(${x} ${y})`}>
                      <g className={styles.cabin} data-qz-wheel="cabin">
                        <g
                          className={styles.cabinSwing}
                          style={{ '--qz-cabin-delay': `${-i * 0.7}s` } as CSSProperties}
                        >
                          <path d="M0 0V13 M-11 20L0 10L11 20" strokeWidth="1.5" />
                          <path
                            d="M-17 22Q0 15 17 22L14 47Q0 53-14 47Z"
                            fill="var(--qz-wheel-surface)"
                            strokeWidth="1.8"
                          />
                          <path
                            d="M-13 24H13V35H-13Z"
                            fill={i % 3 === 0 ? '#659eb9' : '#76aaa0'}
                            fillOpacity=".12"
                            strokeWidth=".8"
                          />
                          <path d="M0 24V46 M-14 38H14 M-11 47H11" opacity=".65" />
                          <path d="M-18 21Q0 14 18 21" strokeWidth="2.6" />
                        </g>
                      </g>
                    </g>
                  </g>
                );
              })}
            </g>
            <g data-qz-wheel="support">
              <path
                d="M310 282L176 596H199L320 314L441 596H464L330 282Z"
                fill="var(--qz-wheel-surface)"
                strokeWidth="2.5"
              />
              <path
                d="M262 416H378 M225 503H416 M262 416L416 503 M378 416L225 503"
                opacity=".7"
                strokeWidth="1.5"
              />
              <path d="M165 598H209 M431 598H475" strokeWidth="6" />
              <circle cx="320" cy="278" fill="var(--qz-wheel-surface)" r="22" strokeWidth="2.5" />
              <circle cx="320" cy="278" r="13" strokeWidth="1.5" />
              <circle cx="320" cy="278" fill="#659eb9" r="5" stroke="none" />
              {[0, 90, 180, 270].map((angle) => (
                <circle
                  cx={320 + Math.cos((angle * Math.PI) / 180) * 17}
                  cy={278 + Math.sin((angle * Math.PI) / 180) * 17}
                  fill="#659eb9"
                  key={angle}
                  r="1.5"
                  stroke="none"
                />
              ))}
            </g>
            <g opacity=".45" strokeWidth="1.4">
              <path d="M116 609V574 M116 590Q91 578 98 564Q116 561 116 590 M116 597Q144 585 136 571Q117 569 116 597" />
              <path d="M514 609V566 M514 585Q490 575 493 556Q515 555 514 585 M514 597Q540 580 532 563Q513 571 514 597" />
            </g>
          </g>
        </svg>
      </div>
    );
  },
);

QingzhouFerrisWheel.displayName = 'QingzhouFerrisWheel';
