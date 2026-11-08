'use client';

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Mirrors the shared CSS spring. One flag keeps optical geometry live for both morphs and panels.
export const CAPSULE_MOTION_MS = 520;

export function useCapsuleMotion(
  collapsed: boolean,
  panelOpen: boolean,
  dock?: RefObject<HTMLElement | null>,
) {
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [morphing, setMorphing] = useState(false);
  const previous = useRef({ collapsed, panelOpen });

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(query.matches);
    query.addEventListener('change', change);
    change();
    return () => query.removeEventListener('change', change);
  }, []);

  useLayoutEffect(() => {
    const changed =
      previous.current.collapsed !== collapsed || previous.current.panelOpen !== panelOpen;
    previous.current = { collapsed, panelOpen };
    if (reducedMotion) {
      setMorphing(false);
      return;
    }
    if (!changed) return;
    setMorphing(true);
    let frame = 0;
    const settle = () => {
      const element = dock?.current;
      if (!element) {
        setMorphing(false);
        return;
      }
      // CSS transitions start at the next paint, after this layout effect's clock. Keep
      // optics live until the actual browser animation and its ResizeObserver layout settle.
      if (
        element
          .getAnimations({ subtree: true })
          .some((animation) => animation.pending || animation.playState === 'running')
      ) {
        frame = requestAnimationFrame(settle);
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setMorphing(false));
      });
    };
    const timer = setTimeout(settle, CAPSULE_MOTION_MS);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [collapsed, dock, panelOpen, reducedMotion]);

  return morphing;
}
