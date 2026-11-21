import { type CSSProperties, useEffect, useRef } from 'react';

import { textStyles } from './text.style';
import { advance, spring } from './textMotion';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
// Cursive and shaping-dependent scripts keep a whole word together.
const connectedScript = /[\u0600-\u109F\u1780-\u17FF]/u;

/** Weight Wave: original 260/22 letters, 150/22 focus and .13 bell width; hover-driven in product. */
export function WeightWave({ children, weight = 450 }: { children: string; weight?: number }) {
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = root.current!;
    const letters = [...element.querySelectorAll<HTMLElement>('[data-wave-letter]')];
    const weights = letters.map(() => spring(weight, 260, 22));
    const focus = spring(-0.2, 150, 22);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0,
      hovering = false;
    const tick = (now: number) => {
      frame = 0;
      if (document.hidden || reduced.matches) return;
      const dt = Math.min((now - (last || now - 16)) / 1000, 1 / 30);
      last = now;
      const bounds = element.getBoundingClientRect();
      const centers = letters.map((letter) => {
        const box = letter.getBoundingClientRect();
        return (box.left + box.width / 2 - bounds.left) / Math.max(bounds.width, 1);
      });
      for (let step = 0; step < 4; step++) {
        advance(focus, dt / 4);
        weights.forEach((value, i) => {
          const d = (centers[i] - focus.x) / 0.13;
          value.target = weight + (820 - weight) * (hovering ? Math.exp(-d * d) : 0);
          advance(value, dt / 4);
        });
      }
      letters.forEach((letter, i) => {
        letter.style.fontWeight = String(Math.min(900, Math.max(100, weights[i].x)));
      });
      if (
        weights.some((value) => Math.abs(value.x - value.target) > 0.1 || Math.abs(value.v) > 0.1)
      )
        frame = requestAnimationFrame(tick);
      else last = 0;
    };
    const wake = () => {
      if (!frame && !document.hidden && !reduced.matches) frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const bounds = element.getBoundingClientRect();
      hovering = true;
      focus.target = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
      wake();
    };
    const reset = () => {
      hovering = false;
      wake();
      if (reduced.matches || document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
        weights.forEach((value, i) => {
          value.x = weight;
          value.v = 0;
          letters[i].style.fontWeight = String(weight);
        });
      }
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', reset);
    reduced.addEventListener('change', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', reset);
      reduced.removeEventListener('change', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [children, weight]);
  return (
    <span
      data-weight-wave
      className={textStyles.wave}
      ref={root}
      style={{ '--wave-weight': weight } as CSSProperties}
    >
      <span className={textStyles.accessible}>{children}</span>
      <span aria-hidden>
        {[...words.segment(children)].map(({ segment, index }) => (
          <span className={textStyles.waveRun} key={index}>
            {(connectedScript.test(segment)
              ? [{ segment, index: 0 }]
              : [...graphemes.segment(segment)]
            ).map(({ segment: letter, index: offset }) => (
              <span data-wave-letter key={offset}>
                {letter}
              </span>
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}
