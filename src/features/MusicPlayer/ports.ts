import { type MusicTrack } from '@/types/music';

import { type AudioEngine, type PlaybackStatus, type PlayerState, type RepeatMode } from './engine';
import { activeLyric, type LyricLine } from './lyrics';

export type MusicPlayerCommand =
  { type: 'play' | 'pause' | 'previous' | 'next' } | { type: 'seek' | 'setVolume'; value: number };

type TrackSnapshot = Readonly<
  Pick<MusicTrack, 'id' | 'name' | 'mimeType' | 'size' | 'source' | 'playbackKind'>
>;
type LineSnapshot = Readonly<LyricLine>;

export interface MusicPlayerSnapshot {
  readonly durationMs: number;
  readonly lyrics: Readonly<{
    currentLine: number;
    lines: readonly LineSnapshot[];
  }>;
  readonly offsetMs: number;
  readonly positionMs: number;
  readonly repeat: RepeatMode;
  readonly shuffle: boolean;
  readonly status: PlaybackStatus;
  readonly track: TrackSnapshot | null;
  readonly userId: string | null;
  readonly volume: number;
}

export type MusicPlayerListener = (snapshot: MusicPlayerSnapshot) => void;

/** The plugin boundary deliberately has no engine, media URL, queue or mutable store. */
export interface MusicPlayerPort {
  command: (input: unknown) => void;
  getSnapshot: () => MusicPlayerSnapshot;
  subscribe: (listener: MusicPlayerListener) => () => void;
}

export interface MusicPlayerSession {
  readonly dispose: () => void;
  readonly port: Readonly<MusicPlayerPort>;
}

function parseCommand(input: unknown): MusicPlayerCommand {
  const invalid = () => new TypeError('MUSIC_PLAYER_INVALID_COMMAND');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => key !== 'type' && key !== 'value')) throw invalid();
  // Read data properties only: a plugin cannot smuggle commands through inherited/accessor fields.
  const type = Object.getOwnPropertyDescriptor(input, 'type')?.value;
  if (type === 'play' || type === 'pause' || type === 'previous' || type === 'next') {
    if (keys.length !== 1) throw invalid();
    return { type };
  }
  if (type === 'seek' || type === 'setVolume') {
    const value = Object.getOwnPropertyDescriptor(input, 'value')?.value;
    if (
      keys.length !== 2 ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (type === 'setVolume' && value > 1)
    )
      throw invalid();
    return { type, value };
  }
  throw invalid();
}

function snapshotFrom(state: PlayerState, previous?: MusicPlayerSnapshot): MusicPlayerSnapshot {
  const active = state.queue.find((track) => track.id === state.activeId);
  const sourceLines = (active && state.lyrics[active.id]?.lines) || [];
  const sameLines =
    previous?.lyrics.lines.length === sourceLines.length &&
    sourceLines.every(
      (line, index) =>
        previous.lyrics.lines[index].text === line.text &&
        previous.lyrics.lines[index].timeMs === line.timeMs,
    );
  const lines = sameLines
    ? previous.lyrics.lines
    : Object.freeze(sourceLines.map(({ text, timeMs }) => Object.freeze({ text, timeMs })));
  const currentLine = activeLyric(sourceLines, state.positionMs);
  const lyrics =
    sameLines && previous.lyrics.currentLine === currentLine
      ? previous.lyrics
      : Object.freeze({ currentLine, lines });
  const sameTrack = active
    ? previous?.track?.id === active.id &&
      previous.track.name === active.name &&
      previous.track.mimeType === active.mimeType &&
      previous.track.source === active.source &&
      previous.track.playbackKind === active.playbackKind &&
      previous.track.size === active.size
    : previous?.track === null;
  const track = sameTrack
    ? previous!.track
    : active
      ? Object.freeze({
          id: active.id,
          mimeType: active.mimeType,
          name: active.name,
          size: active.size,
          source: active.source,
          playbackKind: active.playbackKind,
        })
      : null;
  if (
    previous &&
    previous.track === track &&
    previous.lyrics === lyrics &&
    previous.userId === state.userId &&
    previous.status === state.status &&
    previous.positionMs === state.positionMs &&
    previous.offsetMs === state.offsetMs &&
    previous.durationMs === state.durationMs &&
    previous.volume === state.volume &&
    previous.repeat === state.repeat &&
    previous.shuffle === state.shuffle
  )
    return previous;
  return Object.freeze({
    durationMs: state.durationMs,
    lyrics,
    positionMs: state.positionMs,
    offsetMs: state.offsetMs,
    repeat: state.repeat,
    shuffle: state.shuffle,
    status: state.status,
    track,
    userId: state.userId,
    volume: state.volume,
  });
}

/** A session belongs to this account transition, not merely to an account ID. */
export function createMusicPlayerPort(engine: AudioEngine): MusicPlayerSession {
  const userId = engine.store.getState().userId;
  const listeners = new Set<MusicPlayerListener>();
  let snapshot = snapshotFrom(engine.store.getState());
  let revoked = false;
  let unsubscribeStore = () => {};
  const dispose = () => {
    if (revoked) return;
    revoked = true;
    listeners.clear();
    unsubscribeStore();
  };
  const assertActive = () => {
    if (engine.store.getState().userId !== userId) dispose();
    if (revoked) throw new Error('MUSIC_PLAYER_PORT_REVOKED');
  };
  const notify = (listener: MusicPlayerListener, value: MusicPlayerSnapshot) => {
    try {
      listener(value);
    } catch {
      // A plugin callback must not interrupt shared playback or another plugin's subscription.
    }
  };
  unsubscribeStore = engine.store.subscribe((state) => {
    if (state.userId !== userId) {
      dispose();
      return;
    }
    if (revoked) return;
    const next = snapshotFrom(state, snapshot);
    if (next === snapshot) return;
    snapshot = next;
    const pendingListeners = [...listeners];
    for (const listener of pendingListeners) {
      // Reentrant commands may already have published a newer snapshot or revoked this session.
      if (revoked || snapshot !== next) break;
      if (listeners.has(listener)) notify(listener, next);
    }
  });
  const port: MusicPlayerPort = {
    command(input) {
      assertActive();
      const command = parseCommand(input);
      assertActive();
      switch (command.type) {
        case 'play': {
          engine.play();
          break;
        }
        case 'pause': {
          engine.pause();
          break;
        }
        case 'previous': {
          engine.previous();
          break;
        }
        case 'next': {
          engine.next();
          break;
        }
        case 'seek': {
          engine.seek(command.value);
          break;
        }
        case 'setVolume': {
          engine.setVolume(command.value);
          break;
        }
      }
    },
    getSnapshot() {
      assertActive();
      return snapshot;
    },
    subscribe(listener) {
      assertActive();
      if (typeof listener !== 'function') throw new TypeError('MUSIC_PLAYER_INVALID_LISTENER');
      listeners.add(listener);
      notify(listener, snapshot);
      return () => listeners.delete(listener);
    },
  };
  return Object.freeze({ dispose, port: Object.freeze(port) });
}
