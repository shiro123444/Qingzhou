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
  load = loadSession,
  userId,
}: PropsWithChildren<{
  active: boolean;
  load?: () => Promise<MusicSession>;
  userId: string | null;
}>) {
  const [session, setSession] = useState<MusicSession | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Once requested, navigation does not cancel playback or an in-flight activation.
  const [requested, setRequested] = useState(active);
  useEffect(() => {
    if (active) setRequested(true);
  }, [active]);

  useEffect(() => {
    if (!requested) return;
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
  }, [requested, attempt, load]);

  useLayoutEffect(() => {
    if (!session) return;
    void session.engine.setAccount(userId);
    void session.plugins.start();
  }, [session, userId]);

  useEffect(() => {
    if (!session) return;
    const flush = () => session.engine.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [session]);

  return (
    <MusicActivationContext
      value={{ error, ready: !!session, retry: () => setAttempt((value) => value + 1) }}
    >
      <MusicEngineProvider engine={session?.engine ?? null}>
        <MusicPluginsProvider host={session?.plugins ?? null}>{children}</MusicPluginsProvider>
      </MusicEngineProvider>
    </MusicActivationContext>
  );
}
