'use client';

import { type PropsWithChildren } from 'react';

import { useUserStore } from '@/store/user';

import { MusicPlayerProvider } from './context';
import PlayerShell from './PlayerShell';

/** Lives above Outlet so navigation never owns or recreates the audio element. */
export function MusicPlayerHost({ children }: PropsWithChildren) {
  const userId = useUserStore((state) => (state.isSignedIn ? (state.user?.id ?? null) : null));
  return (
    <MusicPlayerProvider userId={userId}>
      <PlayerShell>{children}</PlayerShell>
    </MusicPlayerProvider>
  );
}
