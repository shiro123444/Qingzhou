'use client';

import { createContext, type PropsWithChildren, use } from 'react';
import { useStore } from 'zustand';

import type { AudioEngine, PlayerState } from './engine';

export const EngineContext = createContext<AudioEngine | null>(null);

export interface MusicActivation {
  error: boolean;
  ready: boolean;
  retry: () => void;
}

export const MusicActivationContext = createContext<MusicActivation>({
  error: false,
  ready: false,
  retry: () => {},
});

export function MusicEngineProvider({
  children,
  engine,
}: PropsWithChildren<{ engine: AudioEngine | null }>) {
  return <EngineContext value={engine}>{children}</EngineContext>;
}

export function useMusicActivation() {
  return use(MusicActivationContext);
}

export function useAudioEngine() {
  const engine = use(EngineContext);
  if (!engine) throw new Error('MusicPlayerProvider is required');
  return engine;
}

export function useMusicPlayer<T>(selector: (state: PlayerState) => T) {
  return useStore(useAudioEngine().store, selector);
}
