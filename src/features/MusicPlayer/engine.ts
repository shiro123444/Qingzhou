import { createStore } from 'zustand/vanilla';

import { type MusicClient, musicClient } from '@/services/music/client';
import { type MusicTrack } from '@/types/music';

import { type LyricLine, parseLrc } from './lyrics';

export type PlaybackStatus =
  'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'blocked' | 'error' | 'ended';
export type RepeatMode = 'sequence' | 'list' | 'single';
export type MusicTransport = Pick<MusicClient, 'resolve' | 'track' | 'search' | 'uploadAudio'>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface PlayerState {
  activeId: string | null;
  durationMs: number;
  error: boolean;
  lyrics: Record<string, { lines: LyricLine[]; text: string }>;
  positionMs: number;
  queue: MusicTrack[];
  repeat: RepeatMode;
  restoring: boolean;
  shuffle: boolean;
  status: PlaybackStatus;
  storageWarning: boolean;
  userId: string | null;
  volume: number;
}

const initialState = (userId: string | null = null): PlayerState => ({
  activeId: null,
  durationMs: 0,
  error: false,
  lyrics: {},
  positionMs: 0,
  queue: [],
  repeat: 'sequence',
  restoring: false,
  shuffle: false,
  status: 'idle',
  storageWarning: false,
  userId,
  volume: 0.8,
});
const keyFor = (id: string) => `qingzhou:music:v1:${encodeURIComponent(id)}`;
const bounded = (value: unknown, max: number, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value))
    : fallback;

/** One lazy media element per mounted main layout. Source and play intents have separate guards. */
export class AudioEngine {
  readonly store = createStore<PlayerState>(() => initialState());
  readonly client: MusicTransport;
  private audio?: HTMLAudioElement;
  private controller?: AbortController;
  private removeListeners?: () => void;
  private generation = 0;
  private playIntent = 0;
  private wantsPlay = false;
  private pendingSeek = 0;
  private history: string[] = [];
  private persistTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;

  constructor(
    private options: {
      client?: MusicTransport;
      createAudio?: () => HTMLAudioElement;
      random?: () => number;
      storage?: StoragePort;
    } = {},
  ) {
    this.client = options.client ?? musicClient;
  }

  private storage() {
    return this.options.storage ?? globalThis.localStorage;
  }
  private update(patch: Partial<PlayerState>) {
    this.store.setState(patch);
  }
  private watchPersistence() {
    this.unsubscribe ??= this.store.subscribe(() => {
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.persist(), 250);
    });
  }
  private persist() {
    const s = this.store.getState();
    if (!s.userId || s.restoring) return;
    try {
      const text = JSON.stringify({
        activeId: s.activeId,
        ids: s.queue.map((track) => track.id),
        lyrics: Object.fromEntries(Object.entries(s.lyrics).map(([id, lyric]) => [id, lyric.text])),
        positionMs: s.positionMs,
        repeat: s.repeat,
        shuffle: s.shuffle,
        volume: s.volume,
      });
      if (text.length > 512 * 1024) throw new Error('STORAGE_LIMIT');
      this.storage()?.setItem(keyFor(s.userId), text);
    } catch {
      if (!s.storageWarning) this.update({ storageWarning: true });
    }
  }

  flush() {
    this.persist();
  }

  async setAccount(userId: string | null) {
    if (this.store.getState().userId === userId) {
      this.watchPersistence();
      return;
    }
    this.persist();
    this.stopSource();
    this.audio = undefined;
    this.history = [];
    this.store.setState(initialState(userId), true);
    this.watchPersistence();
    if (!userId) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const raw = this.storage()?.getItem(keyFor(userId));
      if (!raw) return;
      if (raw.length > 512 * 1024) throw new Error('STORAGE_LIMIT');
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.ids)) return;
      this.update({ restoring: true });
      const ids = [
        ...new Set<string>(
          saved.ids.filter((id: unknown) => typeof id === 'string' && id.length <= 256),
        ),
      ].slice(0, 100);
      const queue: MusicTrack[] = [];
      for (let i = 0; i < ids.length; i += 4) {
        const tracks = await Promise.allSettled(
          ids.slice(i, i + 4).map((id) => this.client.track(id, controller.signal)),
        );
        if (generation !== this.generation) return;
        for (const track of tracks) if (track.status === 'fulfilled') queue.push(track.value);
      }
      const activeId = queue.some((t) => t.id === saved.activeId)
        ? (saved.activeId as string)
        : (queue[0]?.id ?? null);
      const lyrics: PlayerState['lyrics'] = {};
      for (const track of queue) {
        const text = saved.lyrics?.[track.id];
        if (typeof text === 'string') {
          try {
            lyrics[track.id] = { lines: parseLrc(text), text };
          } catch {
            /* Ignore a damaged lyric entry. */
          }
        }
      }
      this.update({
        activeId,
        lyrics,
        positionMs: activeId === saved.activeId ? bounded(saved.positionMs, 86_400_000) : 0,
        queue,
        repeat: ['sequence', 'list', 'single'].includes(saved.repeat) ? saved.repeat : 'sequence',
        restoring: false,
        shuffle: saved.shuffle === true,
        status: activeId ? 'paused' : 'idle',
        volume: bounded(saved.volume, 1, 0.8),
      });
    } catch {
      if (generation === this.generation) this.update({ restoring: false, storageWarning: true });
    }
  }

  private stopSource() {
    this.generation++;
    this.playIntent++;
    this.wantsPlay = false;
    this.controller?.abort();
    this.removeListeners?.();
    this.removeListeners = undefined;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  dispose() {
    this.persist();
    clearTimeout(this.persistTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopSource();
    this.audio = undefined;
    this.store.setState(initialState(), true);
  }

  enqueue(tracks: MusicTrack[]) {
    if (!this.store.getState().userId) return;
    // A user action supersedes an in-flight restore, even if the transport ignores abort.
    if (this.store.getState().restoring) {
      this.stopSource();
      this.update({ restoring: false });
    }
    const queue = [...this.store.getState().queue];
    for (const track of tracks)
      if (!queue.some((t) => t.id === track.id) && queue.length < 100) queue.push(track);
    this.update({ queue });
  }

  playTrack(track: MusicTrack) {
    this.enqueue([track]);
    if (this.store.getState().queue.some((t) => t.id === track.id))
      void this.load(track.id, true, 0);
  }

  private async load(id: string, autoplay: boolean, positionMs: number) {
    if (!this.store.getState().userId) return;
    this.stopSource();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.wantsPlay = autoplay;
    this.pendingSeek = positionMs;
    this.update({
      activeId: id,
      durationMs: 0,
      error: false,
      positionMs,
      restoring: false,
      status: 'loading',
    });
    try {
      const playback = await this.client.resolve(id, controller.signal);
      if (generation !== this.generation) return;
      const audio = (this.audio ??= this.options.createAudio?.() ?? new Audio());
      audio.preload = 'metadata';
      audio.volume = this.store.getState().volume;
      const handlers: [string, EventListener][] = [];
      const on = (name: string, callback: () => void) => {
        const listener = () => {
          if (generation === this.generation) callback();
        };
        handlers.push([name, listener]);
        audio.addEventListener(name, listener);
      };
      let ended = false;
      on('loadedmetadata', () => {
        const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
        this.update({ durationMs });
        this.seek(this.pendingSeek);
        if (!this.wantsPlay) this.update({ status: 'paused' });
      });
      on('timeupdate', () => {
        if (audio.readyState > 0 && Number.isFinite(audio.currentTime))
          this.update({ positionMs: audio.currentTime * 1000 });
      });
      on('playing', () => {
        if (this.wantsPlay && !audio.paused && !audio.ended)
          this.update({ error: false, status: 'playing' });
        else if (!this.wantsPlay) audio.pause();
      });
      on('pause', () => {
        // Native controls or the OS can pause media without a controller command.
        if (audio.paused && !audio.ended) {
          this.wantsPlay = false;
          this.playIntent++;
          this.update({ status: 'paused' });
        }
      });
      on('waiting', () => {
        if (this.wantsPlay && !audio.paused) this.update({ status: 'buffering' });
      });
      on('error', () => {
        this.wantsPlay = false;
        this.update({ error: true, status: 'error' });
      });
      on('ended', () => {
        if (ended || !audio.ended) return;
        ended = true;
        this.wantsPlay = false;
        this.update({ status: 'ended' });
        this.advance(true);
      });
      this.removeListeners = () =>
        handlers.forEach(([name, listener]) => audio.removeEventListener(name, listener));
      audio.src = playback.src;
      audio.load();
      if (this.wantsPlay) void this.attemptPlay();
    } catch {
      if (generation === this.generation) this.update({ error: true, status: 'error' });
    }
  }

  private async attemptPlay() {
    const audio = this.audio;
    if (!audio) return;
    const generation = this.generation;
    const intent = ++this.playIntent;
    this.wantsPlay = true;
    try {
      await audio.play();
    } catch (error) {
      if (generation !== this.generation || intent !== this.playIntent) return;
      this.wantsPlay = false;
      this.update({
        error: true,
        status: (error as Error)?.name === 'NotAllowedError' ? 'blocked' : 'error',
      });
    }
  }

  play() {
    const s = this.store.getState();
    if (!s.userId || !s.activeId) {
      if (s.queue[0]) this.playTrack(s.queue[0]);
      return;
    }
    if (!this.audio?.getAttribute('src') || s.status === 'error' || s.status === 'ended') {
      void this.load(s.activeId, true, s.status === 'ended' ? 0 : s.positionMs);
    } else void this.attemptPlay();
  }
  pause() {
    this.wantsPlay = false;
    this.playIntent++;
    this.audio?.pause();
    if (this.store.getState().activeId) this.update({ status: 'paused' });
  }
  seek(positionMs: number) {
    const duration = this.store.getState().durationMs;
    this.pendingSeek = bounded(positionMs, duration || 86_400_000);
    if (this.audio && this.audio.readyState > 0) {
      try {
        this.audio.currentTime = this.pendingSeek / 1000;
      } catch {
        return;
      }
    }
    this.update({ positionMs: this.pendingSeek });
  }
  setVolume(volume: number) {
    const value = bounded(volume, 1, this.store.getState().volume);
    if (this.audio) this.audio.volume = value;
    this.update({ volume: value });
  }
  setRepeat(repeat: RepeatMode) {
    this.update({ repeat });
  }
  setShuffle(shuffle: boolean) {
    this.history = [];
    this.update({ shuffle });
  }
  next() {
    this.advance(false);
  }
  private advance(automatic: boolean) {
    const s = this.store.getState();
    if (!s.queue.length) return;
    const index = s.queue.findIndex((t) => t.id === s.activeId);
    let next = index + 1;
    if (automatic && s.repeat === 'single') next = index;
    else if (s.shuffle && s.queue.length > 1) {
      const choices = s.queue.filter((t) => t.id !== s.activeId);
      const choice =
        choices[
          Math.floor((this.options.random?.() ?? Math.random()) * choices.length) % choices.length
        ];
      next = s.queue.findIndex((t) => t.id === choice.id);
    } else if (next >= s.queue.length) {
      if (s.repeat === 'list') next = 0;
      else return;
    }
    if (s.activeId && s.activeId !== s.queue[next]?.id) {
      this.history.push(s.activeId);
      if (this.history.length > 100) this.history.shift();
    }
    if (s.queue[next]) void this.load(s.queue[next].id, true, 0);
  }
  previous() {
    const s = this.store.getState();
    if (s.positionMs > 3000) {
      this.seek(0);
      return;
    }
    const index = s.queue.findIndex((t) => t.id === s.activeId);
    const id = s.shuffle
      ? this.history.pop()
      : (s.queue[index - 1] ?? (s.repeat === 'list' ? s.queue.at(-1) : undefined))?.id;
    if (id) void this.load(id, true, 0);
    else this.seek(0);
  }
  move(id: string, direction: -1 | 1) {
    const queue = [...this.store.getState().queue];
    const i = queue.findIndex((t) => t.id === id);
    if (i < 0 || !queue[i + direction]) return;
    [queue[i], queue[i + direction]] = [queue[i + direction], queue[i]];
    this.update({ queue });
  }
  remove(id: string) {
    const s = this.store.getState();
    const queue = s.queue.filter((t) => t.id !== id);
    const lyrics = { ...s.lyrics };
    delete lyrics[id];
    this.history = this.history.filter((item) => item !== id);
    this.update({ lyrics, queue });
    if (s.activeId !== id) return;
    const replacement =
      queue[
        Math.min(
          s.queue.findIndex((t) => t.id === id),
          queue.length - 1,
        )
      ];
    const playing = this.wantsPlay;
    if (replacement) void this.load(replacement.id, playing, 0);
    else {
      this.stopSource();
      this.update({ activeId: null, durationMs: 0, error: false, positionMs: 0, status: 'idle' });
    }
  }
  importLyrics(id: string, text: string) {
    const s = this.store.getState();
    if (!s.queue.some((t) => t.id === id)) return;
    const lines = parseLrc(text);
    if (!lines.length) throw new Error('LRC_EMPTY');
    this.update({ lyrics: { ...s.lyrics, [id]: { lines, text } } });
  }
}
