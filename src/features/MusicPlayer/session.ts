import { AudioEngine } from './engine';
import { MusicPluginHost } from './plugins/runtime';

/** Loaded only after the user opens music. Nothing starts at module evaluation. */
export function createMusicSession() {
  const engine = new AudioEngine();
  const plugins = new MusicPluginHost(engine);
  return { engine, plugins };
}

export type MusicSession = ReturnType<typeof createMusicSession>;
