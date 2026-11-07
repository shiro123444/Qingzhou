'use client';

import { createContext, type PropsWithChildren, use } from 'react';
import { useStore } from 'zustand';

import { type MusicPluginHost } from './runtime';
import { type MusicPluginState } from './types';

const PluginContext = createContext<MusicPluginHost | null>(null);

export function MusicPluginsProvider({
  children,
  host,
}: PropsWithChildren<{ host: MusicPluginHost }>) {
  return <PluginContext value={host}>{children}</PluginContext>;
}

export function useMusicPlugins() {
  const host = use(PluginContext);
  if (!host) throw new Error('MusicPluginsProvider is required');
  return host;
}

export function useMusicPluginState<T>(selector: (state: MusicPluginState) => T) {
  return useStore(useMusicPlugins().store, selector);
}
