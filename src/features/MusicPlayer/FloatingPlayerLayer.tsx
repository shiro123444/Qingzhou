'use client';

import { type PropsWithChildren, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { styles } from './style';

/** Escape workspace clipping while retaining the scene's theme and optical environment. */
export default function FloatingPlayerLayer({ children }: PropsWithChildren) {
  const marker = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const scene =
      marker.current?.closest('[data-qz-glass-scene], .qz-glass-scene') ?? document.body;
    const layer = document.createElement('div');
    layer.className = styles.floatingLayer;
    layer.dataset.musicPlayerLayer = '';
    scene.append(layer);
    setContainer(layer);
    return () => layer.remove();
  }, []);

  return (
    <>
      <span hidden ref={marker} />
      {container && createPortal(children, container)}
    </>
  );
}
