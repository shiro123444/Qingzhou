'use client';

import { useEffect } from 'react';

import { useMusicPlayer } from './context';

/** One persistent, low-resolution album environment shared by every glass pane. */
export default function ArtworkAtmosphere() {
  const coverUrl = useMusicPlayer(
    (state) => state.queue.find((track) => track.id === state.activeId)?.coverUrl,
  );
  const userId = useMusicPlayer((state) => state.userId);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.qz-glass-scene, [data-qz-glass-scene]');
    return () => {
      root?.style.removeProperty('--qz-music-artwork');
    };
  }, [userId]);
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('.qz-glass-scene, [data-qz-glass-scene]');
    if (!root) return;
    let current = true;
    const image = new Image();
    // An account/track without artwork must never keep the previous account's cover.
    if (!coverUrl || !userId) root.style.removeProperty('--qz-music-artwork');
    else {
      const url = new URL(coverUrl, location.href);
      if (url.origin !== location.origin) {
        root.style.removeProperty('--qz-music-artwork');
        return;
      }
      image.decoding = 'async';
      image.onload = () => {
        if (!current) return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 192;
        try {
          const context = canvas.getContext('2d');
          if (!context) return;
          // Blur once on song change, never on the audio clock or the drag/render hot path.
          context.filter = 'blur(14px) saturate(0.82)';
          const scale = 240 / Math.min(image.naturalWidth, image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.drawImage(image, (192 - width) / 2, (192 - height) / 2, width, height);
          root.style.setProperty('--qz-music-artwork', `url("${canvas.toDataURL('image/png')}")`);
        } catch {
          root.style.removeProperty('--qz-music-artwork');
        } finally {
          canvas.width = canvas.height = 0;
        }
      };
      image.onerror = () => {
        if (current) root.style.removeProperty('--qz-music-artwork');
      };
      image.src = url.href;
    }
    return () => {
      current = false;
      image.onload = image.onerror = null;
      image.removeAttribute('src');
    };
  }, [coverUrl, userId]);
  return null;
}
