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
      <img
        alt=""
        aria-hidden="true"
        className={styles.presentationMist}
        draggable={false}
        height={413}
        src="/brand/qingzhou-celadon/wash.webp"
        width={1024}
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
    <img
      data-qz-leaf
      alt=""
      className={styles.leafPendant}
      draggable={false}
      height={171}
      src="/brand/qingzhou-celadon/leaf.webp"
      width={256}
    />
  </span>
));

/** The boat accompanies an empty workspace, away from composer controls. */
export const QingzhouEmptyBoat = memo(() => (
  <span aria-hidden="true" className={styles.harbor}>
    <img
      alt=""
      draggable={false}
      height={351}
      src="/brand/qingzhou-celadon/boat.webp"
      width={384}
    />
  </span>
));

export { styles as qingzhouStyles } from './style';
