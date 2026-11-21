'use client';

import { type PropsWithChildren, useEffect, useLayoutEffect, useState } from 'react';

import { MusicPluginsProvider } from './plugins/context';
import type { MusicSession } from './session';
import { MusicActivationContext, MusicEngineProvider } from './session-context';

const loadSession = async () => (await import('./session')).createMusicSession();

/** Keep the provider tree stable: activating music must not remount an active chat. */
export default function LazyMusicSession({
  active,
  children,
  enabled = true,
  load = loadSession,
  userId,
}: PropsWithChildren<{
  active: boolean;
  enabled?: boolean;
  load?: () => Promise<MusicSession>;
  userId: string | null;
}>) {
  const [session, setSession] = useState<MusicSession | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Once requested, navigation does not cancel playback or an in-flight activation.
  const [requested, setRequested] = useState(active && enabled);
  useEffect(() => {
    if (!enabled) setRequested(false);
    else if (active) setRequested(true);
  }, [active, enabled]);

  useEffect(() => {
    if (!enabled || !requested) {
      setSession(null);
      setError(false);
      return;
    }
    let current = true;
    let owned: MusicSession | undefined;
    setError(false);
    void load().then(
      (value) => {
        if (!current) {
          void value.plugins.stop();
          value.engine.dispose();
          return;
        }
        owned = value;
        setSession(value);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
      if (owned) {
        void owned.plugins.stop();
        owned.engine.dispose();
      }
    };
  }, [requested, enabled, attempt, load]);

  useLayoutEffect(() => {
    if (!enabled || !session) return;
    void session.engine.setAccount(userId);
    void session.plugins.start();
  }, [session, userId, enabled]);

  useEffect(() => {
    if (!enabled || !session) return;
    const flush = () => session.engine.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [session, enabled]);

  return (
    <MusicActivationContext
      value={{
        error: enabled && error,
        ready: enabled && !!session,
        retry: () => setAttempt((value) => value + 1),
      }}
    >
      <MusicEngineProvider engine={enabled ? (session?.engine ?? null) : null}>
        <MusicPluginsProvider host={enabled ? (session?.plugins ?? null) : null}>
          {children}
        </MusicPluginsProvider>
      </MusicEngineProvider>
    </MusicActivationContext>
  );
}
