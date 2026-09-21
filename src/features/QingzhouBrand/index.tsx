'use client';

import { memo, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { styles } from './style';

const assets = '/brand/qingzhou-watercolor';

export const QingzhouWordmark = memo(({ compact = false }: { compact?: boolean }) => (
  <div className={styles.wordmark} data-compact={compact}>
    <img alt="清舟" draggable={false} height={420} src={`${assets}/wordmark.webp`} width={646} />
    {!compact && <span aria-hidden="true">QING ZHOU</span>}
  </div>
));

// The painted cabins stay upright while the wheel turns. The support and foliage
// are stationary; raster details come directly from the supplied original artwork.
export const QingzhouFerrisWheel = memo(
  ({ variant = 'home' }: { variant?: 'home' | 'presentation' }) => {
    const id = useId().replaceAll(':', '');
    const ref = useRef<HTMLDivElement>(null);
    const [moving, setMoving] = useState(false);

    useEffect(() => {
      const node = ref.current;
      if (!node) return;
      let inView = false;
      const sync = () => setMoving(inView && document.visibilityState === 'visible');
      const observer = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        sync();
      });
      observer.observe(node);
      document.addEventListener('visibilitychange', sync);
      return () => {
        observer.disconnect();
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
              id={`${id}-wash`}
              x1="70"
              x2="565"
              y1="70"
              y2="500"
            >
              <stop stopColor="#79cabb" />
              <stop offset=".38" stopColor="#249bcc" />
              <stop offset=".7" stopColor="#a5d7ae" />
              <stop offset="1" stopColor="#50aed2" />
            </linearGradient>
          </defs>
          <g className={styles.rotor} data-qz-wheel="rotor" stroke={`url(#${id}-wash)`}>
            <circle cx="320" cy="278" r="236" strokeWidth="3" />
            <circle cx="320" cy="278" opacity=".65" r="229" strokeWidth="1.5" />
            <circle cx="320" cy="278" opacity=".55" r="155" strokeWidth="2" />
            {Array.from({ length: 12 }, (_, i) => {
              const angle = ((i * 30 - 90) * Math.PI) / 180;
              const x = 320 + Math.cos(angle) * 236;
              const y = 278 + Math.sin(angle) * 236;
              return (
                <g key={i}>
                  <path
                    d={`M320 278 L${x} ${y} M326 279 L${x + 4} ${y + 3}`}
                    opacity=".8"
                    strokeWidth="1.7"
                  />
                  <g transform={`translate(${x} ${y})`}>
                    <g className={styles.cabin} data-qz-wheel="cabin">
                      <image
                        height="61"
                        href={`${assets}/cabin.webp`}
                        width="45"
                        x="-22.5"
                        y="-8"
                      />
                    </g>
                  </g>
                </g>
              );
            })}
          </g>
          <g stroke={`url(#${id}-wash)`} strokeLinecap="round">
            <path d="M315 279 L177 586 M325 279 L457 586" opacity=".68" strokeWidth="11" />
            <path d="M315 279 L177 586 M325 279 L457 586" strokeWidth="3" />
            <path
              d="M263 401H376 M220 493H416 M260 402L413 493 M375 403L222 493"
              opacity=".6"
              strokeWidth="2"
            />
          </g>
          <image height="62" href={`${assets}/hub.webp`} width="56" x="292" y="247" />
          <image height="190" href={`${assets}/foliage.webp`} width="528" x="66" y="482" />
        </svg>
      </div>
    );
  },
);

export const QingzhouPresentationScene = memo(
  ({ active = false, stage }: { active?: boolean; stage: string }) => (
    <div
      data-qz-presentation-scene
      aria-hidden="true"
      className={styles.presentationScene}
      data-active={active}
      data-stage={stage}
    >
      <img
        alt=""
        className={styles.presentationMist}
        draggable={false}
        height={941}
        src={`${assets}/presentation-mist.webp`}
        width={1672}
      />
      <QingzhouFerrisWheel variant="presentation" />
      <span className={styles.presentationRipple}>
        <span />
        <span />
        <span />
      </span>
    </div>
  ),
);

export const QingzhouHomeFrame = memo(({ children }: { children: ReactNode }) => (
  <div className={styles.home}>
    <div aria-hidden="true" className={styles.scenery}>
      <QingzhouFerrisWheel />
    </div>
    <div className={styles.homeContent}>
      <QingzhouWordmark />
      {children}
    </div>
  </div>
));

export const QingzhouComposerOrnaments = memo(() => (
  <span aria-hidden="true" className={styles.ornaments}>
    <span data-qz-leaf className={styles.leafPendant}>
      <img alt="" draggable={false} height={108} src={`${assets}/leaf.webp`} width={110} />
    </span>
    <span className={styles.waterline}>
      <img alt="" draggable={false} height={53} src={`${assets}/boat.webp`} width={102} />
    </span>
  </span>
));

export { styles as qingzhouStyles } from './style';
