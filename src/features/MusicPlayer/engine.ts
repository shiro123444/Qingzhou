import { createStore } from 'zustand/vanilla';

import { type MusicClient, musicClient } from '@/services/music/client';
import { musicAccountClient } from '@/services/music-account';
import { type MusicTrack, musicTrackSchema } from '@/types/music';
import { type MusicPlaylistTracks, musicPlaylistTracksSchema } from '@/types/music-account';

import { type LyricLine, parseLrc } from './lyrics';

export type PlaybackStatus =
  'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'blocked' | 'error' | 'ended';
export type RepeatMode = 'sequence' | 'list' | 'single';
export type MusicTransport = Pick<MusicClient, 'resolve' | 'track' | 'search' | 'uploadAudio'> &
  Partial<Pick<MusicClient, 'lyrics'>>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const MAX_MUSIC_QUEUE_LENGTH = 1000;
const PLAYLIST_PAGE_SIZE = 100;
const PLAYLIST_WINDOW_PAGES = 3;
const MAX_EMPTY_PLAYLIST_PAGES = 3;
const playlistPageCount = (total: number) => Math.max(1, Math.ceil(total / PLAYLIST_PAGE_SIZE));
const validPlaylistPage = (page: number, total: number) =>
  Number.isSafeInteger(page) && page >= 1 && page <= playlistPageCount(total);
export type MusicPlaylistLoader = (
  id: string,
  page: number,
  signal: AbortSignal,
) => Promise<MusicPlaylistTracks>;
export interface PlaylistQueueState {
  appendedCount: number;
  currentIndex: number;
  error: boolean;
  hasMore: boolean;
  id: string;
  loading: boolean;
  name: string;
  page: number;
  revision: string;
  startIndex: number;
  total: number;
}
interface PlaylistSession {
  activeIndex: number;
  activePage: number;
  appended: MusicTrack[];
  controller: AbortController;
  error: boolean;
  history: { id: string; index: number; page: number }[];
  id: string;
  name: string;
  navigation: number;
  pages: Map<number, MusicPlaylistTracks>;
  requests: Map<number, Promise<MusicPlaylistTracks>>;
  retry?: () => void;
  revision: string;
  total: number;
}

export interface PlayerState {
  activeId: string | null;
  durationMs: number;
  error: boolean;
  lyrics: Record<string, { lines: LyricLine[]; text: string }>;
  offsetMs: number;
  playlist: PlaylistQueueState | null;
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
  offsetMs: 0,
  playlist: null,
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
  private playlistSession?: PlaylistSession;

  constructor(
    private options: {
      client?: MusicTransport;
      createAudio?: () => HTMLAudioElement;
      playlistLoader?: MusicPlaylistLoader;
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
  private clearPlaylist() {
    this.playlistSession?.controller.abort();
    this.playlistSession = undefined;
    if (this.store.getState().playlist) this.update({ playlist: null });
  }
  private createPlaylist(page: MusicPlaylistTracks): PlaylistSession {
    if (!Number.isSafeInteger(page.total) || !validPlaylistPage(page.page, page.total))
      throw new Error('MUSIC_PLAYLIST_PAGE_LIMIT');
    this.clearPlaylist();
    const session: PlaylistSession = {
      activeIndex: 0,
      activePage: page.page,
      appended: [],
      controller: new AbortController(),
      error: false,
      history: [],
      id: page.playlist.id,
      name: page.playlist.name,
      navigation: 0,
      pages: new Map([[page.page, page]]),
      requests: new Map(),
      revision: page.revision,
      total: page.total,
    };
    this.playlistSession = session;
    return session;
  }
  private isPlaylistCurrent(session: PlaylistSession) {
    return this.playlistSession === session && !session.controller.signal.aborted;
  }
  /** Keep at most three adjacent metadata pages; audio is resolved only by load(). */
  private syncPlaylist(session: PlaylistSession, patch: Partial<PlayerState> = {}) {
    if (!this.isPlaylistCurrent(session)) return;
    const first = session.pages.has(session.activePage - 1)
      ? session.activePage - 1
      : session.activePage;
    const pages: MusicPlaylistTracks[] = [];
    for (let page = first; page < first + PLAYLIST_WINDOW_PAGES; page++) {
      const value = session.pages.get(page);
      if (!value) break;
      pages.push(value);
    }
    for (const page of session.pages.keys())
      if (!pages.some((item) => item.page === page)) session.pages.delete(page);
    const state = this.store.getState();
    const resolved = state.queue.find((track) => track.id === state.activeId);
    const queue = [
      ...new Map(pages.flatMap((page) => page.tracks).map((track) => [track.id, track])).values(),
    ].map((track) => (track.id === state.activeId && resolved ? resolved : track));
    this.update({
      ...patch,
      queue,
      playlist: {
        appendedCount: session.appended.length,
        currentIndex: (session.activePage - 1) * PLAYLIST_PAGE_SIZE + session.activeIndex,
        error: session.error,
        hasMore: pages.length < PLAYLIST_WINDOW_PAGES && !!pages.at(-1)?.hasMore,
        id: session.id,
        loading: session.requests.size > 0,
        name: session.name,
        page: session.activePage,
        revision: session.revision,
        startIndex: (first - 1) * PLAYLIST_PAGE_SIZE,
        total: session.total,
      },
    });
  }
  private playlistLoading(session: PlaylistSession) {
    const state = this.store.getState();
    if (this.isPlaylistCurrent(session) && state.playlist)
      this.update({
        playlist: { ...state.playlist, error: session.error, loading: session.requests.size > 0 },
      });
  }
  private fetchPlaylistPage(session: PlaylistSession, page: number) {
    if (!validPlaylistPage(page, session.total))
      return Promise.reject(new Error('MUSIC_PLAYLIST_PAGE_LIMIT'));
    const existing = session.pages.get(page);
    if (existing) return Promise.resolve(existing);
    const pending = session.requests.get(page);
    if (pending) return pending;
    const loader =
      this.options.playlistLoader ??
      ((id, number, signal) => musicAccountClient.playlist(id, number, signal));
    const request = Promise.resolve()
      .then(async () => {
        if (!this.isPlaylistCurrent(session)) throw new Error('MUSIC_PLAYLIST_CANCELLED');
        const result = musicPlaylistTracksSchema.parse(
          await loader(session.id, page, session.controller.signal),
        );
        if (!this.isPlaylistCurrent(session)) throw new Error('MUSIC_PLAYLIST_CANCELLED');
        if (
          result.playlist.id !== session.id ||
          result.revision !== session.revision ||
          result.page !== page ||
          !Number.isSafeInteger(result.total) ||
          !validPlaylistPage(page, result.total)
        )
          throw new Error('MUSIC_PLAYLIST_CHANGED');
        session.pages.set(page, result);
        session.total = result.total;
        return result;
      })
      .finally(() => {
        session.requests.delete(page);
        this.playlistLoading(session);
      });
    session.requests.set(page, request);
    this.playlistLoading(session);
    return request;
  }
  private playlistFailure(session: PlaylistSession, retry: () => void) {
    if (!this.isPlaylistCurrent(session)) return;
    session.error = true;
    session.retry = retry;
    this.playlistLoading(session);
  }
  playPlaylist(input: MusicPlaylistTracks, activeId?: string) {
    if (!this.store.getState().userId) return;
    const page = musicPlaylistTracksSchema.parse(input);
    const active = page.tracks.find((track) => track.id === activeId) ?? page.tracks[0];
    if (!active) return;
    const session = this.createPlaylist(page);
    session.activeIndex = page.tracks.findIndex((track) => track.id === active.id);
    this.history = [];
    this.syncPlaylist(session, { activeId: active.id, durationMs: 0, offsetMs: 0, positionMs: 0 });
    void this.load(active.id, true, 0);
  }
  playQueuedTrack(id: string) {
    const session = this.playlistSession;
    const track = this.store.getState().queue.find((item) => item.id === id);
    if (!track) return;
    if (!session) return this.playTrack(track);
    const page = [...session.pages.values()].find((item) =>
      item.tracks.some((entry) => entry.id === id),
    );
    if (!page) return;
    session.navigation++;
    session.activePage = page.page;
    session.activeIndex = page.tracks.findIndex((track) => track.id === id);
    session.error = false;
    session.retry = undefined;
    this.syncPlaylist(session, { activeId: id, durationMs: 0, offsetMs: 0, positionMs: 0 });
    void this.load(id, true, 0);
  }
  async loadMorePlaylist() {
    const session = this.playlistSession;
    if (!session || !this.store.getState().playlist?.hasMore) return;
    const page = Math.max(...session.pages.keys()) + 1;
    session.error = false;
    try {
      await this.fetchPlaylistPage(session, page);
      this.syncPlaylist(session);
    } catch {
      this.playlistFailure(session, () => void this.loadMorePlaylist());
    }
  }
  retryPlaylist() {
    const session = this.playlistSession;
    if (!session) return;
    const retry = session.retry;
    session.retry = undefined;
    session.error = false;
    this.playlistLoading(session);
    if (retry) retry();
    else void this.loadMorePlaylist();
  }
  private prefetchPlaylist() {
    const session = this.playlistSession;
    if (!session) return;
    const page = session.pages.get(session.activePage);
    const index = session.activeIndex;
    if (!page?.hasMore || index < Math.max(0, page.tracks.length - 3)) return;
    void this.fetchPlaylistPage(session, page.page + 1)
      .then(() => this.syncPlaylist(session))
      .catch(() => {
        this.playlistFailure(session, () => this.prefetchPlaylist());
      });
  }
  private async navigatePlaylist(
    direction: 1 | -1,
    automatic = false,
    resume?: { index: number; page: number },
  ) {
    const session = this.playlistSession;
    const state = this.store.getState();
    if (!session || !state.activeId) return;
    if (automatic && state.repeat === 'single') {
      void this.load(state.activeId, true, 0);
      return;
    }
    const current = session.pages.get(session.activePage);
    if (!current) return;
    const currentIndex = session.activeIndex;
    let pageNumber = session.activePage;
    let index = currentIndex + direction;
    const previous = direction === -1 && state.shuffle ? session.history.at(-1) : undefined;
    if (resume) {
      pageNumber = resume.page;
      index = resume.index;
    } else if (state.shuffle && direction === -1) {
      if (!previous) return this.seek(0);
      pageNumber = previous.page;
      index = previous.index;
    } else if (state.shuffle && session.total > 1) {
      const currentGlobal =
        (session.activePage - 1) * PLAYLIST_PAGE_SIZE + Math.max(0, currentIndex);
      const random = bounded(this.options.random?.() ?? Math.random(), 0.999999999);
      let chosen = Math.floor(random * (session.total - 1));
      if (chosen >= currentGlobal) chosen++;
      pageNumber = Math.floor(chosen / PLAYLIST_PAGE_SIZE) + 1;
      index = chosen % PLAYLIST_PAGE_SIZE;
    } else if (index >= current.tracks.length) {
      if (current.hasMore) {
        pageNumber++;
        index = 0;
      } else if (session.appended.length) {
        const tail = [...session.appended];
        this.playTracks(tail);
        return;
      } else if (state.repeat === 'list') {
        pageNumber = 1;
        index = 0;
      } else return;
    } else if (index < 0) {
      if (pageNumber > 1) pageNumber--;
      else if (state.repeat === 'list') pageNumber = playlistPageCount(session.total);
      else return this.seek(0);
      index = -1;
    }
    const intent = ++session.navigation;
    session.error = false;
    session.retry = undefined;
    // Stop only the selected media; the account-scoped metadata session stays alive.
    this.stopSource();
    this.update({ status: 'buffering' });
    try {
      let page: MusicPlaylistTracks;
      let emptyPages = 0;
      for (;;) {
        if (!validPlaylistPage(pageNumber, session.total))
          throw new Error('MUSIC_PLAYLIST_PAGE_LIMIT');
        page = await this.fetchPlaylistPage(session, pageNumber);
        if (!this.isPlaylistCurrent(session)) return;
        if (intent !== session.navigation) {
          this.syncPlaylist(session);
          return;
        }
        if (page.tracks.length) break;
        if (direction === 1 && page.hasMore) {
          pageNumber++;
          index = 0;
        } else if (direction === -1 && pageNumber > 1) {
          pageNumber--;
          index = -1;
        } else if (
          direction === 1 &&
          (state.repeat === 'list' || state.shuffle) &&
          pageNumber > 1 &&
          !session.appended.length
        ) {
          pageNumber = 1;
          index = 0;
        } else if (
          direction === -1 &&
          state.repeat === 'list' &&
          playlistPageCount(session.total) > 1
        ) {
          pageNumber = playlistPageCount(session.total);
          index = -1;
        } else {
          if (direction === 1 && session.appended.length) this.playTracks([...session.appended]);
          else this.update({ status: automatic ? 'ended' : 'paused' });
          return;
        }
        if (++emptyPages >= MAX_EMPTY_PLAYLIST_PAGES) throw new Error('MUSIC_PLAYLIST_EMPTY_PAGES');
      }
      const selectedIndex =
        index < 0 ? page.tracks.length - 1 : Math.min(index, page.tracks.length - 1);
      const track = page.tracks[selectedIndex];
      if (direction === 1 && (page.page !== session.activePage || selectedIndex !== currentIndex)) {
        session.history.push({ id: state.activeId, index: currentIndex, page: session.activePage });
        if (session.history.length > 100) session.history.shift();
      } else if (previous) session.history.pop();
      session.activePage = page.page;
      session.activeIndex = selectedIndex;
      session.pages.set(page.page, page);
      this.syncPlaylist(session, { activeId: track.id, durationMs: 0, offsetMs: 0, positionMs: 0 });
      void this.load(track.id, true, 0);
    } catch {
      if (!this.isPlaylistCurrent(session) || intent !== session.navigation) return;
      this.syncPlaylist(session);
      this.update({ status: 'paused' });
      this.playlistFailure(
        session,
        () => void this.navigatePlaylist(direction, automatic, { index, page: pageNumber }),
      );
    }
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
        ids: s.playlist ? [] : s.queue.map((track) => track.id),
        playlist: this.playlistSession
          ? {
              appended: this.playlistSession.appended,
              id: this.playlistSession.id,
              index: this.playlistSession.activeIndex,
              page: this.playlistSession.activePage,
              revision: this.playlistSession.revision,
            }
          : undefined,
        lyrics: Object.fromEntries(Object.entries(s.lyrics).map(([id, lyric]) => [id, lyric.text])),
        playbackKind: s.queue.find((track) => track.id === s.activeId)?.playbackKind,
        positionMs: s.positionMs,
        offsetMs: s.offsetMs,
        durationMs: s.durationMs,
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
    this.clearPlaylist();
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
      const queue: MusicTrack[] = [];
      if (saved.playlist) {
        const source = saved.playlist;
        if (
          typeof source.id !== 'string' ||
          !/^\d{1,20}$/u.test(source.id) ||
          typeof source.revision !== 'string' ||
          source.revision.length > 100 ||
          !Number.isSafeInteger(source.page) ||
          source.page < 1
        )
          throw new Error('INVALID_PLAYLIST_SOURCE');
        const loader =
          this.options.playlistLoader ??
          ((id, page, signal) => musicAccountClient.playlist(id, page, signal));
        const page = musicPlaylistTracksSchema.parse(
          await loader(source.id, source.page, controller.signal),
        );
        if (generation !== this.generation) return;
        if (
          page.playlist.id !== source.id ||
          page.revision !== source.revision ||
          page.page !== source.page
        )
          throw new Error('MUSIC_PLAYLIST_CHANGED');
        const session = this.createPlaylist(page);
        session.activeIndex =
          Number.isSafeInteger(source.index) &&
          source.index >= 0 &&
          page.tracks[source.index]?.id === saved.activeId
            ? source.index
            : Math.max(
                0,
                page.tracks.findIndex((track) => track.id === saved.activeId),
              );
        if (Array.isArray(source.appended)) {
          const ids = new Set<string>();
          for (const item of source.appended.slice(0, MAX_MUSIC_QUEUE_LENGTH)) {
            const track = musicTrackSchema.safeParse(item);
            if (track.success && !ids.has(track.data.id)) {
              ids.add(track.data.id);
              session.appended.push(track.data);
            }
          }
        }
        queue.push(...page.tracks);
      } else {
        const ids = [
          ...new Set<string>(
            saved.ids.filter((id: unknown) => typeof id === 'string' && id.length <= 256),
          ),
        ].slice(0, MAX_MUSIC_QUEUE_LENGTH);
        for (let i = 0; i < ids.length; i += 4) {
          const tracks = await Promise.allSettled(
            ids.slice(i, i + 4).map((id) => this.client.track(id, controller.signal)),
          );
          if (generation !== this.generation) return;
          for (const track of tracks) if (track.status === 'fulfilled') queue.push(track.value);
        }
      }
      const activeId = queue.some((t) => t.id === saved.activeId)
        ? (saved.activeId as string)
        : (queue[0]?.id ?? null);
      const durationMs = activeId === saved.activeId ? bounded(saved.durationMs, 86_400_000) : 0;
      if (
        activeId &&
        activeId === saved.activeId &&
        durationMs > 0 &&
        (saved.playbackKind === 'full' || saved.playbackKind === 'preview')
      ) {
        // Restore the last resolved label for display only; Play always resolves current rights.
        const activeIndex = queue.findIndex((track) => track.id === activeId);
        queue[activeIndex] = { ...queue[activeIndex], playbackKind: saved.playbackKind };
      }
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
        durationMs,
        offsetMs: activeId === saved.activeId ? bounded(saved.offsetMs, 86_400_000) : 0,
        lyrics,
        positionMs: activeId === saved.activeId ? bounded(saved.positionMs, 86_400_000) : 0,
        queue,
        repeat: ['sequence', 'list', 'single'].includes(saved.repeat) ? saved.repeat : 'sequence',
        restoring: false,
        shuffle: saved.shuffle === true,
        status: activeId ? 'paused' : 'idle',
        volume: bounded(saved.volume, 1, 0.8),
      });
      if (this.playlistSession) this.syncPlaylist(this.playlistSession);
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
    this.clearPlaylist();
    clearTimeout(this.persistTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.stopSource();
    this.audio = undefined;
    this.store.setState(initialState(), true);
  }

  enqueue(tracks: MusicTrack[]) {
    if (!this.store.getState().userId) return;
    const playlist = this.playlistSession;
    if (playlist) {
      const ids = new Set(playlist.appended.map((track) => track.id));
      for (const track of tracks) {
        if (ids.has(track.id) || playlist.appended.length >= MAX_MUSIC_QUEUE_LENGTH) continue;
        ids.add(track.id);
        playlist.appended.push(track);
      }
      this.syncPlaylist(playlist);
      return;
    }
    // A user action supersedes an in-flight restore, even if the transport ignores abort.
    if (this.store.getState().restoring) {
      this.stopSource();
      this.update({ restoring: false });
    }
    const queue = [...this.store.getState().queue];
    for (const track of tracks)
      if (!queue.some((t) => t.id === track.id) && queue.length < MAX_MUSIC_QUEUE_LENGTH)
        queue.push(track);
    this.update({ queue });
  }

  playTrack(track: MusicTrack) {
    if (!this.store.getState().userId) return;
    this.clearPlaylist();
    this.enqueue([track]);
    const state = this.store.getState();
    if (!state.queue.some((item) => item.id === track.id)) {
      // Explicit playback replaces the last inactive entry when the queue is full.
      const displaced = [...state.queue].reverse().find((item) => item.id !== state.activeId);
      if (displaced) this.remove(displaced.id);
      this.enqueue([track]);
    }
    if (this.store.getState().queue.some((t) => t.id === track.id))
      void this.load(track.id, true, 0);
  }

  playTracks(tracks: MusicTrack[]) {
    const state = this.store.getState();
    if (!state.userId || !tracks.length) return;
    this.clearPlaylist();
    const queue: MusicTrack[] = [];
    const ids = new Set<string>();
    for (const track of tracks) {
      if (ids.has(track.id)) continue;
      ids.add(track.id);
      queue.push(track);
      if (queue.length === MAX_MUSIC_QUEUE_LENGTH) break;
    }
    this.history = [];
    this.update({
      lyrics: Object.fromEntries(Object.entries(state.lyrics).filter(([id]) => ids.has(id))),
      queue,
    });
    void this.load(queue[0].id, true, 0);
  }

  private async load(id: string, autoplay: boolean, positionMs: number) {
    const previous = this.store.getState();
    if (!previous.userId) return;
    this.stopSource();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.wantsPlay = autoplay;
    this.pendingSeek = positionMs;
    this.update({
      activeId: id,
      durationMs: previous.activeId === id ? previous.durationMs : 0,
      offsetMs: previous.activeId === id ? previous.offsetMs : 0,
      error: false,
      positionMs,
      restoring: false,
      status: 'loading',
    });
    try {
      const playback = await this.client.resolve(id, controller.signal);
      if (generation !== this.generation) return;
      this.update({
        offsetMs: bounded(playback.offsetMs, 86_400_000),
        durationMs: bounded(playback.track.durationMs, 86_400_000),
        queue: this.store
          .getState()
          .queue.map((track) => (track.id === id ? playback.track : track)),
      });
      const audio = (this.audio ??= this.options.createAudio?.() ?? new Audio());
      // A provider preview can retain the full recording's MP3/Xing duration header.
      // The granted clip length is the transport's upper bound for playback and seek.
      const previewMs =
        playback.track.playbackKind === 'preview'
          ? bounded(playback.track.durationMs, Number.MAX_SAFE_INTEGER)
          : 0;
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
      const finish = () => {
        if (ended) return;
        ended = true;
        this.wantsPlay = false;
        this.update({ status: 'ended' });
        this.advance(true);
      };
      on('loadedmetadata', () => {
        const mediaDuration = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
        const durationMs = previewMs
          ? Math.min(mediaDuration || previewMs, previewMs)
          : mediaDuration;
        this.update({ durationMs });
        this.seek(
          this.wantsPlay && durationMs > 0 && this.pendingSeek >= durationMs ? 0 : this.pendingSeek,
        );
        if (!this.wantsPlay) this.update({ status: 'paused' });
      });
      on('timeupdate', () => {
        if (audio.readyState > 0 && Number.isFinite(audio.currentTime)) {
          const positionMs = audio.currentTime * 1000;
          this.update({ positionMs: previewMs ? Math.min(positionMs, previewMs) : positionMs });
          if (previewMs && positionMs >= previewMs && !ended) {
            audio.pause();
            finish();
          }
        }
      });
      on('playing', () => {
        if (this.wantsPlay && !audio.paused && !audio.ended)
          this.update({ error: false, status: 'playing' });
        else if (!this.wantsPlay) audio.pause();
      });
      on('pause', () => {
        // Native controls or the OS can pause media without a controller command.
        if (!ended && audio.paused && !audio.ended) {
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
        if (audio.ended) finish();
      });
      this.removeListeners = () =>
        handlers.forEach(([name, listener]) => audio.removeEventListener(name, listener));
      audio.src = playback.src;
      audio.load();
      if (this.wantsPlay) void this.attemptPlay();
      this.prefetchPlaylist();
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
    if (this.playlistSession) {
      this.playlistSession.navigation++;
      this.playlistSession.retry = undefined;
    }
    const s = this.store.getState();
    if (!s.userId || !s.activeId) {
      if (s.queue[0]) this.playTrack(s.queue[0]);
      return;
    }
    if (!this.audio?.getAttribute('src') || s.status === 'error' || s.status === 'ended') {
      void this.load(s.activeId, true, s.status === 'ended' ? 0 : s.positionMs);
    } else void this.attemptPlay();
  }
  /** Drop cached account-authorized media before account permissions change. Local files stay live. */
  invalidatePlayback() {
    const state = this.store.getState();
    this.clearPlaylist();
    if (state.queue.find((track) => track.id === state.activeId)?.source !== 'kugou') return;
    this.stopSource();
    this.update({ durationMs: 0, offsetMs: 0, error: false, positionMs: 0, status: 'paused' });
  }

  /** Refresh rights explicitly; connecting or disconnecting never starts playback by itself. */
  async refreshPlayback() {
    const state = this.store.getState();
    if (
      !state.userId ||
      !state.activeId ||
      state.queue.find((track) => track.id === state.activeId)?.source !== 'kugou'
    )
      return;
    this.invalidatePlayback();
    await this.load(state.activeId, false, 0);
  }
  pause() {
    if (this.playlistSession) {
      this.playlistSession.navigation++;
      this.playlistSession.retry = undefined;
    }
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
  readPositionMs() {
    const state = this.store.getState();
    const position =
      this.audio?.getAttribute('src') && this.audio.readyState > 0
        ? this.audio.currentTime * 1000
        : state.positionMs;
    return bounded(position, state.durationMs || 86_400_000, state.positionMs);
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
    if (this.playlistSession) this.playlistSession.history = [];
    this.update({ shuffle });
  }
  next() {
    this.advance(false);
  }
  private advance(automatic: boolean) {
    if (this.playlistSession) {
      void this.navigatePlaylist(1, automatic);
      return;
    }
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
    if (this.readPositionMs() > 3000) {
      this.seek(0);
      return;
    }
    if (this.playlistSession) {
      void this.navigatePlaylist(-1);
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
    if (this.playlistSession) return;
    const queue = [...this.store.getState().queue];
    const i = queue.findIndex((t) => t.id === id);
    if (i < 0 || !queue[i + direction]) return;
    [queue[i], queue[i + direction]] = [queue[i + direction], queue[i]];
    this.update({ queue });
  }
  remove(id: string) {
    if (this.playlistSession) return;
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
