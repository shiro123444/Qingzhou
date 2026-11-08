import { type MusicLyrics } from '@/types/music';

import { type LyricLine } from '../lyrics';

export interface LyricsPluginView {
  readonly currentLine: number;
  readonly durationMs: number;
  readonly lines: readonly Readonly<LyricLine>[];
  readonly positionMs: number;
  readonly retry: () => void;
  readonly seekLine: (index: number) => void;
  readonly source: 'library' | 'kugou' | null;
  readonly status: 'loading' | 'ready' | 'empty' | 'error';
  readonly trackId: string | null;
  readonly trackName: string | null;
}

/** Only the active track in this account session may request lyrics; no media or token access. */
export interface MusicLyricsSource {
  get: (trackId: string, signal: AbortSignal) => Promise<MusicLyrics>;
}

export interface MusicPluginState {
  enabled: boolean;
  lyrics: LyricsPluginView | null;
  status: 'disabled' | 'loading' | 'active' | 'error';
  storageWarning: boolean;
  userId: string | null;
}

export interface LyricsViewSlot {
  clear: () => void;
  publish: (view: LyricsPluginView) => void;
}
