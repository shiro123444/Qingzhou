import { type LyricLine } from '../lyrics';

export interface LyricsPluginView {
  readonly currentLine: number;
  readonly durationMs: number;
  readonly lines: readonly Readonly<LyricLine>[];
  readonly positionMs: number;
  readonly seekLine: (index: number) => void;
  readonly trackId: string | null;
  readonly trackName: string | null;
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
