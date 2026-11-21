'use client';

import { type PropsWithChildren } from 'react';
import { useLocation } from 'react-router-dom';

import { useBuiltinPluginEnabled } from '@/hooks/useBuiltinPluginEnabled';
import { useUserStore } from '@/store/user';

import LazyMusicSession from './LazyMusicSession';
import PlayerShell from './PlayerShell';

/** Lives above Outlet so navigation never owns or recreates the audio element. */
export function MusicPlayerHost({ children }: PropsWithChildren) {
  const enabled = useBuiltinPluginEnabled('music');
  const { pathname } = useLocation();
  const userId = useUserStore((state) => (state.isSignedIn ? (state.user?.id ?? null) : null));
  return (
    <LazyMusicSession
      active={pathname === '/music' || pathname.startsWith('/music/')}
      enabled={enabled}
      userId={userId}
    >
      <PlayerShell>{children}</PlayerShell>
    </LazyMusicSession>
  );
}
