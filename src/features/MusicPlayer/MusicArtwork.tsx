'use client';

import { createStaticStyles, cx } from 'antd-style';
import { useState } from 'react';

export const MUSIC_ARTWORK = '/brand/qingzhou-celadon/music-record.webp';

const styles = createStaticStyles(({ css }) => ({
  image: css`
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;

    &[data-music-artwork='celadon'] {
      object-fit: contain;
    }
  `,
}));

/** Real album art stays intact; missing or failed artwork uses the same celadon family. */
export default function MusicArtwork({
  coverUrl,
  className,
}: {
  coverUrl?: string;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string>();
  const fallback = !coverUrl || coverUrl === failedSource;
  return (
    <img
      alt=""
      className={cx(styles.image, className)}
      data-music-artwork={fallback ? 'celadon' : 'cover'}
      decoding="async"
      draggable={false}
      src={fallback ? MUSIC_ARTWORK : coverUrl}
      onError={() => {
        if (!fallback) setFailedSource(coverUrl);
      }}
    />
  );
}
