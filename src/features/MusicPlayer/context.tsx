'use client';

import {
  createContext,
  type PropsWithChildren,
  use,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { useStore } from 'zustand';

import { AudioEngine, type PlayerState } from './engine';
import { MusicPluginsProvider } from './plugins/context';
import { MusicPluginHost } from './plugins/runtime';

const EngineContext = createContext<AudioEngine | null>(null);

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

export function useAudioEngine() {
  const engine = use(EngineContext);
  if (!engine) throw new Error('MusicPlayerProvider is required');
  return engine;
}

export function useMusicPlayer<T>(selector: (state: PlayerState) => T) {
  return useStore(useAudioEngine().store, selector);
}
