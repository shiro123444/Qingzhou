'use client';

import { memo, type ReactNode } from 'react';

import { QingzhouFerrisWheel } from './FerrisWheel';
import { styles } from './style';

export { QingzhouFerrisWheel } from './FerrisWheel';

const assets = '/brand/qingzhou-watercolor';

export const QingzhouWordmark = memo(({ compact = false }: { compact?: boolean }) => (
  <div className={styles.wordmark} data-compact={compact}>
    <img alt="清舟" draggable={false} height={420} src={`${assets}/wordmark.webp`} width={646} />
    {!compact && <span aria-hidden="true">QING ZHOU</span>}
  </div>
));

export const QingzhouPresentationScene = memo(
  ({ active = false, stage }: { active?: boolean; stage: string }) => (
    <div
      data-qz-presentation-scene
      aria-hidden="true"
      className={styles.presentationScene}
      data-active={active}
      data-stage={stage}
    >
      <svg
        aria-hidden="true"
        className={styles.presentationMist}
        fill="none"
        preserveAspectRatio="xMidYMax slice"
        viewBox="0 0 1200 700"
      >
        <path
          d="M0 560Q260 510 540 567T1200 552 M0 584Q290 558 600 587T1200 575 M0 620Q350 591 710 622T1200 604"
          stroke="currentColor"
          strokeOpacity=".09"
        />
      </svg>
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
      <svg fill="none" viewBox="0 0 40 48">
        <path
          d="M20 3C5 12 4 31 18 43C31 39 38 23 20 3Z"
          fill="currentColor"
          fillOpacity=".15"
          stroke="currentColor"
        />
        <path
          d="M20 4L18 44M19 19L11 14M19 28L28 20M18 36L10 28"
          stroke="currentColor"
          strokeOpacity=".65"
        />
      </svg>
    </span>
    <span className={styles.waterline}>
      <svg fill="none" viewBox="0 0 60 42">
        <path d="M8 29H53L44 37H18Z" fill="currentColor" fillOpacity=".18" stroke="currentColor" />
        <path d="M29 3V29M26 6L10 25H26Z" stroke="currentColor" />
        <path d="M32 7L47 25H32Z" fill="currentColor" fillOpacity=".1" stroke="currentColor" />
      </svg>
    </span>
  </span>
));

export { styles as qingzhouStyles } from './style';
