'use client';

import { lazy, type PropsWithChildren, Suspense } from 'react';

import FloatingPlayerLayer from './FloatingPlayerLayer';
import { useMusicActivation } from './session-context';
import { styles } from './style';

const ArtworkAtmosphere = lazy(() => import('./ArtworkAtmosphere'));
const MiniPlayer = lazy(() => import('./MiniPlayer'));

export default function PlayerShell({ children }: PropsWithChildren) {
  const { ready } = useMusicActivation();
  return (
    <div className={styles.shell}>
      <Suspense fallback={null}>{ready && <ArtworkAtmosphere />}</Suspense>
      <div className={styles.content}>{children}</div>
      {ready && (
        <FloatingPlayerLayer>
          <Suspense fallback={null}>
            <MiniPlayer />
          </Suspense>
        </FloatingPlayerLayer>
      )}
    </div>
  );
}
