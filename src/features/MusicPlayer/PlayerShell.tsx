'use client';

import { type PropsWithChildren } from 'react';

import MiniPlayer from './MiniPlayer';
import { styles } from './style';

export default function PlayerShell({ children }: PropsWithChildren) {
  return (
    <div className={styles.shell}>
      <div className={styles.content}>{children}</div>
      <MiniPlayer />
    </div>
  );
}
