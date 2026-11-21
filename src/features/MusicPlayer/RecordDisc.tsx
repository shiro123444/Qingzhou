import { createStaticStyles } from 'antd-style';
import { useEffect, useRef } from 'react';

import MusicArtwork from './MusicArtwork';

const styles = createStaticStyles(({ css }) => ({
  record: css`
    position: relative;

    display: grid;
    place-items: center;

    width: 100%;
    height: 100%;
    border-radius: 50%;

    background:
      conic-gradient(
        from -30deg,
        transparent,
        #ffffff20 16%,
        transparent 23% 58%,
        #ffffff16 67%,
        transparent 75%
      ),
      repeating-radial-gradient(circle, #17382f 0 2px, #26483e 2.5px 3px, #152e28 3.5px 5px);
    box-shadow:
      inset 0 0 0 1px #ffffff20,
      0 4px 12px #0e221b24;

    &::after {
      content: '';

      position: absolute;
      inset: 47%;

      border-radius: 50%;

      background: #dfede5;
      box-shadow: 0 0 0 1px #061b3040;
    }

    img {
      width: 52%;
      height: 52%;
      border-radius: 50%;
      object-fit: cover;
    }
  `,
}));

/** Kokonut's 200°/s cruise and .22/.2s spin-up/down, following the actual audio state. */
export function RecordDisc({ playing, coverUrl }: { playing: boolean; coverUrl?: string }) {
  const disc = useRef<HTMLSpanElement>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    const element = disc.current!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0,
      omega = 0,
      angle = 0,
      visible = true;
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || !visible || reduced.matches) {
        last = 0;
        return;
      }
      const dt = Math.min((now - (last || now - 16)) / 1000, 0.05);
      last = now;
      const target = playingRef.current ? 200 : 0;
      omega = target + (omega - target) * Math.exp(-dt / (target ? 0.22 : 0.2));
      if (Math.abs(omega - target) < 2) omega = target;
      angle = (angle + omega * dt) % 360;
      element.style.transform = `rotate(${angle}deg)`;
      if (omega || target) frame = requestAnimationFrame(tick);
      else last = 0;
    };
    const sync = () => {
      if (document.hidden || !visible || reduced.matches) {
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    wake.current = sync;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            sync();
          });
    observer?.observe(element);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      wake.current = () => {};
      document.removeEventListener('visibilitychange', sync);
      reduced.removeEventListener('change', sync);
    };
  }, []);
  useEffect(() => wake.current(), [playing]);
  return (
    <span aria-hidden data-record-disc className={styles.record} ref={disc}>
      <MusicArtwork coverUrl={coverUrl} />
    </span>
  );
}
