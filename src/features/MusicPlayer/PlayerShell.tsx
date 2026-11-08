'use client';

import { type PropsWithChildren } from 'react';

import ArtworkAtmosphere from './ArtworkAtmosphere';
import MiniPlayer from './MiniPlayer';
import { styles } from './style';

export default function PlayerShell({ children }: PropsWithChildren) {
  return (
    <div className={styles.shell}>
      <ArtworkAtmosphere />
      <div className={styles.content}>{children}</div>
      <MiniPlayer />
    </div>
  );
}
