'use client';

import { type PropsWithChildren, useEffect, useLayoutEffect, useState } from 'react';

import { AudioEngine } from './engine';
import { MusicPluginsProvider } from './plugins/context';
import { MusicPluginHost } from './plugins/runtime';
import { EngineContext } from './session-context';

export { useAudioEngine, useMusicPlayer } from './session-context';

export function MusicPlayerProvider({
  children,
  engine: supplied,
  userId,
}: PropsWithChildren<{
  engine?: AudioEngine;
  userId: string | null;
}>) {
  const [engine] = useState(() => supplied ?? new AudioEngine());
  const [plugins] = useState(() => new MusicPluginHost(engine));
  useLayoutEffect(() => {
    void engine.setAccount(userId);
  }, [engine, userId]);
  useLayoutEffect(() => () => engine.dispose(), [engine]);
  useLayoutEffect(() => {
    void plugins.start();
    return () => {
      void plugins.stop();
    };
  }, [plugins]);
  useEffect(() => {
    const flush = () => engine.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [engine]);
  return (
    <EngineContext value={engine}>
      <MusicPluginsProvider host={plugins}>{children}</MusicPluginsProvider>
    </EngineContext>
  );
}
