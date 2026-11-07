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
  useLayoutEffect(() => {
    void engine.setAccount(userId);
  }, [engine, userId]);
  useLayoutEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => {
    const flush = () => engine.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [engine]);
  return <EngineContext value={engine}>{children}</EngineContext>;
}

export function useAudioEngine() {
  const engine = use(EngineContext);
  if (!engine) throw new Error('MusicPlayerProvider is required');
  return engine;
}

export function useMusicPlayer<T>(selector: (state: PlayerState) => T) {
  return useStore(useAudioEngine().store, selector);
}
