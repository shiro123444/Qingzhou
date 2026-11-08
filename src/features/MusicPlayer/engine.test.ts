import { afterEach, describe, expect, it, vi } from 'vitest';

import { type MusicPlayback, type MusicTrack } from '@/types/music';
import { type MusicPlaylistTracks } from '@/types/music-account';

import { AudioEngine, MAX_MUSIC_QUEUE_LENGTH, type MusicTransport } from './engine';

const track = (id: string): MusicTrack => ({
  id,
  mimeType: 'audio/mpeg',
  name: `${id}.mp3`,
  size: 1000,
  source: 'library',
  version: '1',
});
const playback = (id: string): MusicPlayback => ({
  src: `/api/runtime/music/tracks/${id}/stream`,
  track: track(id),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const settlePlaylist = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const playlistPage = (page: number, total = 669): MusicPlaylistTracks => ({
  hasMore: page * 100 < total,
  page,
  playlist: { id: '101', kind: 'liked', name: 'A long playlist', trackCount: total },
  revision: '55d73ef1-8f31-4e90-abf7-2d3e663d988e',
  total,
  tracks: Array.from(
    { length: Math.min(100, Math.max(0, total - (page - 1) * 100)) },
    (_, index) => ({
      ...track(`song-${(page - 1) * 100 + index}`),
      durationMs: 120000,
      source: 'kugou',
      playbackKind: 'full',
    }),
  ),
});

class TestAudio extends EventTarget {
  currentTime = 0;
  duration = 120;
  ended = false;
  paused = true;
  preload = '';
  readyState = 0;
  src = '';
  volume = 1;
  load = vi.fn(() => {
    this.readyState = 0;
    this.ended = false;
  });
  play = vi.fn(async () => {
    this.paused = false;
    this.emit('playing');
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.emit('pause');
  });
  getAttribute(name: string) {
    return name === 'src' ? this.src : null;
  }
  removeAttribute() {
    this.src = '';
  }
  emit(name: string) {
    this.dispatchEvent(new Event(name));
  }
  metadata() {
    this.readyState = 1;
    this.emit('loadedmetadata');
  }
  finish() {
    this.ended = true;
    this.paused = true;
    this.emit('ended');
  }
}

const engines: AudioEngine[] = [];
function setup(options: ConstructorParameters<typeof AudioEngine>[0] = {}) {
  const audio = new TestAudio();
  const createAudio = vi.fn(() => audio as unknown as HTMLAudioElement);
  const client: MusicTransport = {
    resolve: vi.fn(async (id) => playback(id)),
    track: vi.fn(async (id) => track(id)),
    search: vi.fn(async () => []),
    uploadAudio: vi.fn(async () => track('upload')),
  };
  const storage = new Map<string, string>();
  const engine = new AudioEngine({
    client,
    createAudio,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => {
        storage.delete(key);
      },
      setItem: (key, value) => {
        storage.set(key, value);
      },
    },
    ...options,
  });
  engines.push(engine);
  return { audio, client, createAudio, engine, state: engine.store.getState, storage };
}
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.useRealTimers();
});

describe('shared AudioEngine', () => {
  it('discards an authorized cached source and refreshes account rights without autoplay', async () => {
    const { audio, client, createAudio, engine, state } = setup();
    const online: MusicTrack = { ...track('a'), source: 'kugou', playbackKind: 'full' };
    vi.mocked(client.resolve).mockResolvedValue({ ...playback('a'), track: online });
    await engine.setAccount('alice');
    engine.playTrack(online);
    await settle();
    audio.metadata();
    expect(audio.paused).toBe(false);
    engine.invalidatePlayback();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    expect(state()).toMatchObject({
      activeId: 'a',
      status: 'paused',
      durationMs: 0,
      positionMs: 0,
      offsetMs: 0,
    });
    vi.mocked(client.resolve).mockResolvedValue({
      ...playback('a'),
      offsetMs: 30000,
      track: { ...online, playbackKind: 'preview', durationMs: 60000 },
    });
    await engine.refreshPlayback();
    audio.metadata();
    expect(audio.paused).toBe(true);
    expect(state()).toMatchObject({ status: 'paused', offsetMs: 30000, durationMs: 60000 });
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    vi.mocked(client.resolve).mockImplementation(async (id) => playback(id));
    engine.playTrack(track('local'));
    await settle();
    const calls = vi.mocked(client.resolve).mock.calls.length;
    engine.invalidatePlayback();
    await engine.refreshPlayback();
    expect(vi.mocked(client.resolve)).toHaveBeenCalledTimes(calls);
    expect(audio.paused).toBe(false);
  });

  it('rejects late account-authorized resolves after rights invalidation', async () => {
    const { audio, client, engine, state } = setup();
    const online: MusicTrack = { ...track('a'), source: 'kugou', playbackKind: 'full' };
    const old = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(old.promise);
    await engine.setAccount('alice');
    engine.playTrack(online);
    const signal = vi.mocked(client.resolve).mock.calls[0][1]!;
    engine.invalidatePlayback();
    expect(signal.aborted).toBe(true);
    old.resolve({ ...playback('a'), track: online });
    await settle();
    expect(audio.src).toBe('');
    expect(audio.play).not.toHaveBeenCalled();
    expect(state().status).toBe('paused');
  });
  it('replays a restored finished preview from the start on the first Play click', async () => {
    const { audio, client, engine, state, storage } = setup();
    const preview: MusicTrack = {
      ...track('a'),
      source: 'kugou',
      playbackKind: 'preview',
      durationMs: 60000,
    };
    vi.mocked(client.track).mockResolvedValue(preview);
    vi.mocked(client.resolve).mockResolvedValue({ ...playback('a'), track: preview });
    storage.set(
      'qingzhou:music:v1:alice',
      JSON.stringify({
        activeId: 'a',
        ids: ['a'],
        positionMs: 60000,
        lyrics: {},
        repeat: 'sequence',
        shuffle: false,
        volume: 0.8,
      }),
    );
    await engine.setAccount('alice');
    expect(state()).toMatchObject({ activeId: 'a', status: 'paused', positionMs: 60000 });
    expect(audio.play).not.toHaveBeenCalled();
    engine.play();
    await settle();
    audio.duration = 269;
    audio.metadata();
    expect(state()).toMatchObject({ status: 'playing', positionMs: 0, durationMs: 60000 });
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });
  it('uses the granted preview duration when the MP3 retains a full-song header', async () => {
    const { audio, client, engine, state } = setup();
    await engine.setAccount('alice');
    const preview: MusicTrack = {
      ...track('a'),
      source: 'kugou',
      playbackKind: 'preview',
      durationMs: 60000,
      artist: 'Artist',
      coverUrl: '/api/runtime/music/tracks/a/cover',
    };
    vi.mocked(client.resolve).mockResolvedValue({ ...playback('a'), track: preview });
    engine.playTrack({ ...preview, durationMs: 269000 });
    await settle();
    audio.duration = 269;
    audio.metadata();
    expect(state().durationMs).toBe(60000);
    expect(state().queue[0]).toEqual(preview);
    engine.seek(240000);
    expect(audio.currentTime).toBe(60);
    audio.currentTime = 60.1;
    audio.emit('timeupdate');
    expect(state().positionMs).toBe(60000);
    expect(state().status).toBe('ended');
    expect(audio.paused).toBe(true);
    // Real media dispatches pause asynchronously after the preview was finished.
    audio.emit('pause');
    expect(state().status).toBe('ended');
  });
  it('bounds the queue and rejects invalid lyrics without replacing existing lines', async () => {
    const { engine, state } = setup();
    await engine.setAccount('alice');
    engine.enqueue(
      Array.from({ length: MAX_MUSIC_QUEUE_LENGTH + 10 }, (_, index) => track(String(index))),
    );
    expect(state().queue).toHaveLength(MAX_MUSIC_QUEUE_LENGTH);
    engine.importLyrics('0', '[00:01]original');
    expect(() => engine.importLyrics('0', 'untimed text')).toThrow('LRC_EMPTY');
    expect(state().lyrics['0'].lines[0].text).toBe('original');
    engine.setRepeat('list');
    engine.playTrack(track('0'));
    await settle();
    engine.previous();
    await settle();
    expect(state().activeId).toBe(String(MAX_MUSIC_QUEUE_LENGTH - 1));
  });

  it.each(['0', String(MAX_MUSIC_QUEUE_LENGTH - 1)])(
    'plays an explicit new selection from a full queue with %s active',
    async (activeId) => {
      const { audio, client, createAudio, engine, state } = setup();
      await engine.setAccount('alice');
      engine.enqueue(
        Array.from({ length: MAX_MUSIC_QUEUE_LENGTH }, (_, index) => track(String(index))),
      );
      engine.playTrack(track(activeId));
      await settle();
      const displacedId = String(
        MAX_MUSIC_QUEUE_LENGTH - (activeId === String(MAX_MUSIC_QUEUE_LENGTH - 1) ? 2 : 1),
      );
      engine.importLyrics(displacedId, '[00:01]Displaced lyric');
      const missingActive: string[] = [];
      const unsubscribe = engine.store.subscribe((snapshot) => {
        if (snapshot.activeId && !snapshot.queue.some((item) => item.id === snapshot.activeId))
          missingActive.push(snapshot.activeId);
      });
      engine.playTrack(track('new'));
      await settle();
      unsubscribe();
      expect(state().queue).toHaveLength(MAX_MUSIC_QUEUE_LENGTH);
      expect(state().queue.some((item) => item.id === activeId)).toBe(true);
      expect(state().queue.some((item) => item.id === displacedId)).toBe(false);
      expect(state().lyrics[displacedId]).toBeUndefined();
      expect(state().activeId).toBe('new');
      expect(state().status).toBe('playing');
      expect(audio.src).toContain('/new/stream');
      expect(client.resolve).toHaveBeenCalledTimes(2);
      expect(createAudio).toHaveBeenCalledTimes(1);
      expect(missingActive).toEqual([]);
    },
  );

  it('replaces a manual queue with unique tracks and keeps normal enqueue bounded', async () => {
    const { audio, createAudio, engine, state } = setup();
    await engine.setAccount('alice');
    engine.playTrack(track('old'));
    await settle();
    engine.importLyrics('old', '[00:01]Old lyric');
    engine.playTracks([
      track('batch-0'),
      track('batch-0'),
      ...Array.from({ length: MAX_MUSIC_QUEUE_LENGTH + 10 }, (_, index) => track(`batch-${index}`)),
    ]);
    await settle();
    expect(state().queue.map((item) => item.id)).toEqual(
      Array.from({ length: MAX_MUSIC_QUEUE_LENGTH }, (_, index) => `batch-${index}`),
    );
    expect(state()).toMatchObject({ activeId: 'batch-0', status: 'playing', lyrics: {} });
    expect(audio.src).toContain('/batch-0/stream');
    expect(createAudio).toHaveBeenCalledTimes(1);
    engine.enqueue([track('overflow')]);
    expect(state().queue).toHaveLength(MAX_MUSIC_QUEUE_LENGTH);
    expect(state().queue.some((item) => item.id === 'overflow')).toBe(false);
    engine.playTracks([]);
    expect(state().activeId).toBe('batch-0');
    expect(audio.paused).toBe(false);
  });

  it('ignores playlist playback without an account and cancels older pending sources', async () => {
    const { audio, client, engine, state } = setup();
    engine.playTracks([track('anonymous')]);
    expect(client.resolve).not.toHaveBeenCalled();
    expect(state().queue).toEqual([]);
    await engine.setAccount('alice');
    const old = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(old.promise);
    engine.playTrack(track('old'));
    const signal = vi.mocked(client.resolve).mock.calls[0][1]!;
    engine.playTracks([track('selected')]);
    await settle();
    old.resolve(playback('old'));
    await settle();
    expect(signal.aborted).toBe(true);
    expect(state()).toMatchObject({ activeId: 'selected', status: 'playing' });
    expect(state().queue.map((item) => item.id)).toEqual(['selected']);
    expect(audio.src).toContain('/selected/stream');
  });

  it('plays all 669 playlist tracks lazily with one audio and a three-page metadata window', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page));
    const { audio, client, createAudio, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1));
    await settlePlaylist();
    expect(loader).not.toHaveBeenCalled();
    expect(client.resolve).toHaveBeenCalledTimes(1);
    expect(state().playlist).toMatchObject({ currentIndex: 0, total: 669, startIndex: 0 });
    for (let index = 1; index < 669; index++) {
      audio.finish();
      await settlePlaylist();
      expect(state().activeId).toBe(`song-${index}`);
      expect(state().status).toBe('playing');
      expect(state().playlist?.currentIndex).toBe(index);
      expect(state().queue.length).toBeLessThanOrEqual(300);
      expect(new Set(state().queue.map((item) => item.id)).size).toBe(state().queue.length);
    }
    expect(loader.mock.calls.map((call) => call[1])).toEqual([2, 3, 4, 5, 6, 7]);
    expect(client.track).not.toHaveBeenCalled();
    expect(client.resolve).toHaveBeenCalledTimes(669);
    expect(createAudio).toHaveBeenCalledTimes(1);
    audio.finish();
    await settlePlaylist();
    expect(state().status).toBe('ended');
    expect(state().activeId).toBe('song-668');
  });

  it('advances duplicate track occurrences by source position and restores the second occurrence', async () => {
    const page = playlistPage(1, 3);
    page.tracks = [page.tracks[0], page.tracks[0], page.tracks[2]];
    const loader = vi.fn(async () => page);
    const original = setup({ playlistLoader: loader });
    await original.engine.setAccount('alice');
    original.engine.playPlaylist(page);
    await settlePlaylist();
    original.audio.finish();
    await settlePlaylist();
    expect(original.state()).toMatchObject({ activeId: 'song-0', status: 'playing' });
    expect(original.state().playlist?.currentIndex).toBe(1);
    expect(original.state().queue.map((item) => item.id)).toEqual(['song-0', 'song-2']);
    original.engine.pause();
    original.engine.dispose();
    expect(JSON.parse(original.storage.get('qingzhou:music:v1:alice')!).playlist.index).toBe(1);
    const restored = setup({
      playlistLoader: loader,
      storage: {
        getItem: (key) => original.storage.get(key) ?? null,
        removeItem: (key) => original.storage.delete(key),
        setItem: (key, value) => original.storage.set(key, value),
      },
    });
    await restored.engine.setAccount('alice');
    expect(restored.state().playlist?.currentIndex).toBe(1);
    restored.engine.play();
    await settlePlaylist();
    restored.audio.finish();
    await settlePlaylist();
    expect(restored.state().activeId).toBe('song-2');
    expect(restored.state().playlist?.currentIndex).toBe(2);
    restored.audio.finish();
    await settlePlaylist();
    expect(restored.state().status).toBe('ended');
  });

  it('preserves duplicate source positions across page boundaries and shuffle history', async () => {
    const first = playlistPage(1, 102);
    const second = playlistPage(2, 102);
    second.tracks[0] = first.tracks[99];
    const { audio, engine, state } = setup({ playlistLoader: async () => second });
    await engine.setAccount('alice');
    engine.playPlaylist(first, 'song-99');
    await settlePlaylist();
    audio.finish();
    await settlePlaylist();
    expect(state().activeId).toBe('song-99');
    expect(state().playlist?.currentIndex).toBe(100);
    audio.finish();
    await settlePlaylist();
    expect(state().activeId).toBe('song-101');

    const duplicates = playlistPage(1, 3);
    duplicates.tracks[1] = duplicates.tracks[0];
    const shuffled = setup({ random: () => 0 });
    await shuffled.engine.setAccount('alice');
    shuffled.engine.playPlaylist(duplicates);
    await settlePlaylist();
    shuffled.engine.setShuffle(true);
    shuffled.engine.next();
    await settlePlaylist();
    expect(shuffled.state().playlist?.currentIndex).toBe(1);
    shuffled.engine.previous();
    await settlePlaylist();
    expect(shuffled.state().activeId).toBe('song-0');
    expect(shuffled.state().playlist?.currentIndex).toBe(0);
  });

  it('crosses page 50 and restores page 51 without a fixed playlist size limit', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page, 5100));
    const original = setup({ playlistLoader: loader });
    await original.engine.setAccount('alice');
    original.engine.playPlaylist(playlistPage(50, 5100), 'song-4999');
    await settlePlaylist();
    original.audio.finish();
    await settlePlaylist();
    expect(original.state().activeId).toBe('song-5000');
    expect(original.state().playlist).toMatchObject({ currentIndex: 5000, page: 51, total: 5100 });
    expect(loader.mock.calls.map((call) => call[1])).toEqual([51]);
    original.engine.pause();
    original.engine.dispose();
    loader.mockClear();
    const restored = setup({
      playlistLoader: loader,
      storage: {
        getItem: (key) => original.storage.get(key) ?? null,
        removeItem: (key) => original.storage.delete(key),
        setItem: (key, value) => original.storage.set(key, value),
      },
    });
    await restored.engine.setAccount('alice');
    expect(restored.state().playlist).toMatchObject({ currentIndex: 5000, page: 51, total: 5100 });
    expect(restored.state().status).toBe('paused');
    expect(loader.mock.calls.map((call) => call[1])).toEqual([51]);
    expect(restored.client.track).not.toHaveBeenCalled();
    expect(restored.client.resolve).not.toHaveBeenCalled();
  });

  it('bounds consecutive empty pages and retries from the next unchecked page', async () => {
    const loader = vi.fn(async (_id: string, page: number) => ({
      ...playlistPage(page),
      tracks: page >= 2 && page <= 4 ? [] : playlistPage(page).tracks,
    }));
    const { audio, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1), 'song-99');
    await settlePlaylist();
    audio.finish();
    await settlePlaylist();
    expect(loader.mock.calls.map((call) => call[1])).toEqual([2, 3, 4]);
    expect(state()).toMatchObject({ activeId: 'song-99', status: 'paused' });
    expect(state().playlist?.error).toBe(true);
    engine.retryPlaylist();
    await settlePlaylist();
    expect(loader.mock.calls.map((call) => call[1])).toEqual([2, 3, 4, 5]);
    expect(state()).toMatchObject({ activeId: 'song-400', status: 'playing' });
    expect(state().playlist).toMatchObject({ currentIndex: 400, error: false });
  });

  it('repeats the complete playlist when its final source page contains no playable tracks', async () => {
    const { audio, engine, state } = setup({
      playlistLoader: async (_id, page) => ({ ...playlistPage(page, 200), tracks: [] }),
    });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1, 200), 'song-99');
    await settlePlaylist();
    engine.setRepeat('list');
    audio.finish();
    await settlePlaylist();
    expect(state()).toMatchObject({ activeId: 'song-0', status: 'playing' });
    expect(state().playlist).toMatchObject({ currentIndex: 0, error: false, total: 200 });
  });

  it('preloads only metadata while paused and keeps queued selections inside the playlist', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page));
    const { client, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1));
    await settlePlaylist();
    engine.pause();
    await engine.loadMorePlaylist();
    await engine.loadMorePlaylist();
    await engine.loadMorePlaylist();
    expect(state().queue).toHaveLength(300);
    expect(state().playlist).toMatchObject({ hasMore: false, total: 669, currentIndex: 0 });
    expect(state().status).toBe('paused');
    expect(loader.mock.calls.map((call) => call[1])).toEqual([2, 3]);
    expect(client.resolve).toHaveBeenCalledTimes(1);
    engine.playQueuedTrack('song-200');
    await settlePlaylist();
    expect(state().playlist).toMatchObject({ currentIndex: 200, startIndex: 100, page: 3 });
    engine.previous();
    await settlePlaylist();
    expect(state().activeId).toBe('song-199');
    expect(state().playlist?.id).toBe('101');
  });

  it('restores only the active playlist page paused and resolves rights only when played', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page));
    const original = setup({ playlistLoader: loader });
    await original.engine.setAccount('alice');
    original.engine.playPlaylist(playlistPage(4), 'song-350');
    await settlePlaylist();
    original.audio.metadata();
    original.engine.seek(42000);
    original.engine.enqueue([track('tail')]);
    original.engine.pause();
    original.engine.dispose();
    const saved = JSON.parse(original.storage.get('qingzhou:music:v1:alice')!);
    expect(saved.ids).toEqual([]);
    expect(saved.playlist).toMatchObject({ id: '101', page: 4 });
    const restored = setup({
      playlistLoader: loader,
      storage: {
        getItem: (key) => original.storage.get(key) ?? null,
        removeItem: (key) => original.storage.delete(key),
        setItem: (key, value) => original.storage.set(key, value),
      },
    });
    await restored.engine.setAccount('alice');
    expect(loader.mock.calls.map((call) => call[1])).toEqual([4]);
    expect(restored.client.track).not.toHaveBeenCalled();
    expect(restored.client.resolve).not.toHaveBeenCalled();
    expect(restored.createAudio).not.toHaveBeenCalled();
    expect(restored.state()).toMatchObject({
      activeId: 'song-350',
      positionMs: 42000,
      status: 'paused',
    });
    expect(restored.state().playlist).toMatchObject({
      total: 669,
      startIndex: 300,
      currentIndex: 350,
      appendedCount: 1,
    });
    restored.engine.play();
    await settlePlaylist();
    expect(restored.client.resolve).toHaveBeenCalledTimes(1);
  });

  it('handles page boundaries, full-list repeat, single repeat and random history beyond loaded pages', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page));
    const { audio, engine, state } = setup({ playlistLoader: loader, random: () => 0.999 });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(7), 'song-668');
    await settlePlaylist();
    engine.setRepeat('list');
    engine.next();
    await settlePlaylist();
    expect(state().activeId).toBe('song-0');
    engine.previous();
    await settlePlaylist();
    expect(state().activeId).toBe('song-668');
    engine.setRepeat('single');
    audio.finish();
    await settlePlaylist();
    expect(state().activeId).toBe('song-668');
    engine.playPlaylist(playlistPage(1));
    await settlePlaylist();
    engine.setShuffle(true);
    engine.next();
    await settlePlaylist();
    expect(state().activeId).toBe('song-668');
    expect(state().playlist?.currentIndex).toBe(668);
    engine.previous();
    await settlePlaylist();
    expect(state().activeId).toBe('song-0');
    expect(state().playlist?.total).toBe(669);
  });

  it('keeps additions after the complete playlist and enters a manual tail queue at its real end', async () => {
    const loader = vi.fn(async (_id: string, page: number) => playlistPage(page));
    const { audio, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(6), 'song-599');
    await settlePlaylist();
    engine.enqueue([track('tail-a'), track('tail-a'), track('tail-b')]);
    expect(state().playlist).toMatchObject({ total: 669, appendedCount: 2 });
    expect(state().queue.some((item) => item.id === 'tail-a')).toBe(false);
    audio.finish();
    await settlePlaylist();
    expect(state().activeId).toBe('song-600');
    engine.playQueuedTrack('song-668');
    await settlePlaylist();
    audio.finish();
    await settlePlaylist();
    expect(state().playlist).toBeNull();
    expect(state().queue.map((item) => item.id)).toEqual(['tail-a', 'tail-b']);
    expect(state().activeId).toBe('tail-a');
    expect(state().status).toBe('playing');
  });

  it('waits for unloaded songs, retries a failed page and never treats the loaded tail as the end', async () => {
    const page = deferred<MusicPlaylistTracks>();
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(page.promise);
    const { audio, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1), 'song-99');
    await settlePlaylist();
    expect(state().playlist?.error).toBe(true);
    audio.finish();
    await settlePlaylist();
    expect(state().status).toBe('buffering');
    expect(state().activeId).toBe('song-99');
    page.reject(new Error('still offline'));
    await settlePlaylist();
    expect(state().status).toBe('paused');
    expect(state().playlist?.error).toBe(true);
    loader.mockResolvedValue(playlistPage(2));
    engine.retryPlaylist();
    await settlePlaylist();
    expect(state().activeId).toBe('song-100');
    expect(state().status).toBe('playing');
    expect(state().playlist?.error).toBe(false);
  });

  it.each(['pause', 'outside', 'logout', 'rights'] as const)(
    'rejects late page navigation after %s',
    async (action) => {
      const pending = deferred<MusicPlaylistTracks>();
      const loader = vi.fn((_id: string, _page: number, _signal: AbortSignal) => pending.promise);
      const { client, engine, state } = setup({ playlistLoader: loader });
      vi.mocked(client.resolve).mockImplementation(async (id) => ({
        ...playback(id),
        track: { ...track(id), source: 'kugou' },
      }));
      await engine.setAccount('alice');
      engine.playPlaylist(playlistPage(1), 'song-99');
      await settlePlaylist();
      engine.next();
      await settlePlaylist();
      if (action === 'pause') engine.pause();
      if (action === 'outside') engine.playTrack(track('outside'));
      if (action === 'logout') await engine.setAccount(null);
      if (action === 'rights') engine.invalidatePlayback();
      pending.resolve(playlistPage(2));
      await settlePlaylist();
      expect(state().activeId).not.toBe('song-100');
      if (action === 'pause') expect(state().status).toBe('paused');
      else expect(loader.mock.calls[0][2].aborted).toBe(true);
      if (action === 'logout') expect(state().queue).toEqual([]);
      if (action === 'outside') expect(state().activeId).toBe('outside');
    },
  );

  it('reads native sub-frame playback positions without emitting store updates', async () => {
    const { audio, engine, state } = setup();
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    await settle();
    audio.metadata();
    const changes = vi.fn();
    const unsubscribe = engine.store.subscribe(changes);
    audio.currentTime = 1.234567;
    expect(engine.readPositionMs()).toBeCloseTo(1234.567);
    expect(state().positionMs).toBe(0);
    expect(changes).not.toHaveBeenCalled();
    engine.pause();
    expect(engine.readPositionMs()).toBeCloseTo(1234.567);
    engine.seek(9000);
    expect(engine.readPositionMs()).toBe(9000);
    audio.currentTime = 9000;
    expect(engine.readPositionMs()).toBe(state().durationMs);
    unsubscribe();
  });

  it('rejects pages from a changed account revision without resolving their audio', async () => {
    const loader = vi.fn(async () => ({
      ...playlistPage(2),
      revision: '66d73ef1-8f31-4e90-abf7-2d3e663d988e',
    }));
    const { client, engine, state } = setup({ playlistLoader: loader });
    await engine.setAccount('alice');
    engine.playPlaylist(playlistPage(1), 'song-99');
    await settlePlaylist();
    engine.next();
    await settlePlaylist();
    expect(state()).toMatchObject({ activeId: 'song-99', status: 'paused' });
    expect(state().playlist?.error).toBe(true);
    expect(state().queue.some((item) => item.id === 'song-100')).toBe(false);
    expect(client.resolve).toHaveBeenCalledTimes(1);
  });

  it('discards a saved playlist when its account revision changes and cancels late restoration', async () => {
    const saved = JSON.stringify({
      ids: [],
      activeId: 'song-350',
      playlist: { id: '101', page: 4, revision: playlistPage(4).revision },
    });
    const changed = setup({
      playlistLoader: async () => ({
        ...playlistPage(4),
        revision: '66d73ef1-8f31-4e90-abf7-2d3e663d988e',
      }),
    });
    changed.storage.set('qingzhou:music:v1:alice', saved);
    await changed.engine.setAccount('alice');
    expect(changed.state()).toMatchObject({
      activeId: null,
      playlist: null,
      queue: [],
      storageWarning: true,
    });
    expect(changed.client.resolve).not.toHaveBeenCalled();

    const pending = deferred<MusicPlaylistTracks>();
    const loader = vi.fn((_id: string, _page: number, _signal: AbortSignal) => pending.promise);
    const late = setup({ playlistLoader: loader });
    late.storage.set('qingzhou:music:v1:alice', saved);
    const restoring = late.engine.setAccount('alice');
    late.engine.playTrack(track('chosen'));
    await settlePlaylist();
    pending.resolve(playlistPage(4));
    await restoring;
    expect(loader.mock.calls[0][2].aborted).toBe(true);
    expect(late.state()).toMatchObject({ activeId: 'chosen', playlist: null, status: 'playing' });
    expect(late.state().queue.map((item) => item.id)).toEqual(['chosen']);
  });
  it('uses one media element for all tracks and derives playback from native events', async () => {
    const { audio, createAudio, engine, state } = setup();
    await engine.setAccount('alice');
    audio.play.mockImplementation(async () => {});
    engine.playTrack(track('a'));
    await settle();
    expect(state().status).toBe('loading');
    audio.metadata();
    audio.paused = false;
    audio.emit('playing');
    expect(state().status).toBe('playing');
    audio.pause();
    expect(state().status).toBe('paused');
    engine.play();
    await settle();
    audio.paused = false;
    audio.emit('playing');
    audio.currentTime = 5;
    audio.emit('timeupdate');
    engine.pause();
    expect(state()).toMatchObject({ positionMs: 5000, status: 'paused', durationMs: 120_000 });
    engine.playTrack(track('b'));
    await settle();
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(audio.src).toContain('/b/stream');
  });

  it('ignores a slow superseded resolve and aborts it', async () => {
    const { client, engine, audio, state } = setup();
    const pending = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockImplementationOnce(() => pending.promise);
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    const signal = vi.mocked(client.resolve).mock.calls[0][1]!;
    engine.playTrack(track('b'));
    await settle();
    pending.resolve(playback('a'));
    await settle();
    expect(signal.aborted).toBe(true);
    expect(audio.src).toContain('/b/stream');
    expect(state().activeId).toBe('b');
  });

  it('honors pause while resolving and does not autoplay when it arrives', async () => {
    const { engine, client, audio, state } = setup();
    const pending = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(pending.promise);
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    engine.pause();
    pending.resolve(playback('a'));
    await settle();
    audio.metadata();
    expect(audio.play).not.toHaveBeenCalled();
    expect(state().status).toBe('paused');
  });

  it('shows autoplay rejection, retries on user action, and ignores rejected old play intents', async () => {
    const { engine, audio, state } = setup();
    const pending = deferred<void>();
    audio.play.mockReturnValueOnce(pending.promise);
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    await settle();
    engine.pause();
    pending.reject(new DOMException('blocked', 'NotAllowedError'));
    await settle();
    expect(state().status).toBe('paused');
    audio.play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    engine.play();
    await settle();
    expect(state().status).toBe('blocked');
    engine.play();
    await settle();
    expect(state().status).toBe('playing');
  });

  it('clamps seek/volume, reports buffering and leaves media failures recoverable', async () => {
    const { engine, audio, state, client } = setup();
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    await settle();
    audio.metadata();
    engine.seek(999_000);
    expect(audio.currentTime).toBe(120);
    engine.setVolume(-1);
    expect(audio.volume).toBe(0);
    audio.emit('waiting');
    expect(state().status).toBe('buffering');
    audio.emit('error');
    expect(state().status).toBe('error');
    engine.play();
    await settle();
    expect(client.resolve).toHaveBeenCalledTimes(2);
    expect(state().status).toBe('playing');
  });

  it('deduplicates, reorders, removes the active track, and stops an emptied queue', async () => {
    const { engine, state, audio } = setup();
    await engine.setAccount('alice');
    engine.enqueue([track('a'), track('b'), track('a'), track('c')]);
    engine.move('c', -1);
    expect(state().queue.map((t) => t.id)).toEqual(['a', 'c', 'b']);
    engine.playTrack(track('a'));
    await settle();
    engine.remove('a');
    await settle();
    expect(state().activeId).toBe('c');
    engine.remove('b');
    engine.remove('c');
    expect(state()).toMatchObject({ activeId: null, queue: [], status: 'idle' });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
  });

  it('advances once at ended, stops sequence at the tail, wraps list and repeats single', async () => {
    const { engine, state, audio } = setup();
    await engine.setAccount('alice');
    engine.enqueue([track('a'), track('b')]);
    engine.playTrack(track('a'));
    await settle();
    audio.finish();
    audio.emit('ended');
    await settle();
    expect(state().activeId).toBe('b');
    audio.finish();
    await settle();
    expect(state().status).toBe('ended');
    engine.setRepeat('list');
    engine.next();
    await settle();
    expect(state().activeId).toBe('a');
    engine.setRepeat('single');
    audio.finish();
    await settle();
    expect(state().activeId).toBe('a');
    expect(state().status).toBe('playing');
    engine.next();
    await settle();
    expect(state().activeId).toBe('b');
  });

  it('supports shuffle history and restarts the current track after three seconds', async () => {
    const { engine, state, audio } = setup({ random: () => 0.99 });
    await engine.setAccount('alice');
    engine.enqueue([track('a'), track('b'), track('c')]);
    engine.playTrack(track('a'));
    await settle();
    engine.setShuffle(true);
    engine.next();
    await settle();
    expect(state().activeId).toBe('c');
    engine.previous();
    await settle();
    expect(state().activeId).toBe('a');
    audio.metadata();
    engine.seek(5000);
    engine.previous();
    expect(state().positionMs).toBe(0);
  });

  it('persists only account queue IDs/settings/lyrics and restores owned tracks paused', async () => {
    vi.useFakeTimers();
    const { engine, state, storage, client, audio, createAudio } = setup();
    await engine.setAccount('alice');
    engine.enqueue([track('a'), track('gone')]);
    engine.playTrack(track('a'));
    await settle();
    audio.metadata();
    engine.seek(7200);
    engine.setVolume(0.3);
    engine.setRepeat('list');
    engine.importLyrics('a', '[00:01.00]Hello');
    await vi.advanceTimersByTimeAsync(300);
    const raw = storage.get('qingzhou:music:v1:alice')!;
    expect(raw).not.toContain('/stream');
    expect(raw).not.toContain('a.mp3');
    await engine.setAccount('bob');
    expect(state()).toMatchObject({ activeId: null, queue: [], lyrics: {}, userId: 'bob' });
    expect(audio.paused).toBe(true);
    vi.mocked(client.track).mockImplementation(async (id) => {
      if (id === 'gone') throw new Error('404');
      return track(id);
    });
    await engine.setAccount('alice');
    expect(state()).toMatchObject({
      activeId: 'a',
      positionMs: 7200,
      repeat: 'list',
      status: 'paused',
      volume: 0.3,
    });
    expect(state().queue.map((t) => t.id)).toEqual(['a']);
    expect(state().lyrics.a.lines[0].text).toBe('Hello');
    expect(createAudio).toHaveBeenCalledTimes(1);
    engine.play();
    await settle();
    audio.metadata();
    expect(audio.currentTime).toBe(7.2);
  });

  it('restores the last full-playback label paused but resolves current rights before playing', async () => {
    const original = setup();
    const preview: MusicTrack = {
      ...track('a'),
      source: 'kugou',
      playbackKind: 'preview',
      durationMs: 60000,
    };
    vi.mocked(original.client.resolve).mockResolvedValue({
      ...playback('a'),
      track: { ...preview, playbackKind: 'full', durationMs: 269000 },
    });
    await original.engine.setAccount('alice');
    original.engine.playTrack(preview);
    await settle();
    original.audio.duration = 269;
    original.audio.metadata();
    original.engine.seek(153000);
    original.engine.pause();
    original.engine.dispose();
    expect(JSON.parse(original.storage.get('qingzhou:music:v1:alice')!)).toMatchObject({
      playbackKind: 'full',
      durationMs: 269000,
      positionMs: 153000,
    });

    const restored = setup({
      storage: {
        getItem: (key) => original.storage.get(key) ?? null,
        removeItem: (key) => original.storage.delete(key),
        setItem: (key, value) => original.storage.set(key, value),
      },
    });
    vi.mocked(restored.client.track).mockResolvedValue(preview);
    vi.mocked(restored.client.resolve).mockResolvedValue({ ...playback('a'), track: preview });
    await restored.engine.setAccount('alice');
    expect(restored.state()).toMatchObject({
      activeId: 'a',
      durationMs: 269000,
      positionMs: 153000,
      status: 'paused',
    });
    expect(restored.state().queue[0].playbackKind).toBe('full');
    expect(restored.client.resolve).not.toHaveBeenCalled();
    expect(restored.createAudio).not.toHaveBeenCalled();

    restored.engine.play();
    await settle();
    restored.audio.metadata();
    expect(restored.client.resolve).toHaveBeenCalledTimes(1);
    expect(restored.state().queue[0].playbackKind).toBe('preview');
    expect(restored.state()).toMatchObject({ durationMs: 60000, positionMs: 0 });
  });

  it.each([
    { durationMs: 269000 },
    { durationMs: 269000, playbackKind: 'unknown' },
    { playbackKind: 'full' },
    { durationMs: 0, playbackKind: 'full' },
    { durationMs: '269000', playbackKind: 'full' },
    { activeId: 'missing', durationMs: 269000, playbackKind: 'full' },
  ])(
    'keeps public metadata when the saved playback label cannot be restored: %j',
    async (saved) => {
      const { client, createAudio, engine, state, storage } = setup();
      vi.mocked(client.track).mockResolvedValue({
        ...track('a'),
        source: 'kugou',
        playbackKind: 'preview',
      });
      storage.set(
        'qingzhou:music:v1:alice',
        JSON.stringify({ activeId: 'a', ids: ['a'], ...saved }),
      );
      await engine.setAccount(null);
      expect(state().queue).toEqual([]);
      await engine.setAccount('alice');
      expect(state().queue[0].playbackKind).toBe('preview');
      expect(state().status).toBe('paused');
      expect(client.resolve).not.toHaveBeenCalled();
      expect(createAudio).not.toHaveBeenCalled();
    },
  );

  it('logout invalidates late resolve and restore, and an explicit action supersedes restoration', async () => {
    const { engine, client, state, storage, createAudio } = setup();
    const pending = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(pending.promise);
    await engine.setAccount('alice');
    engine.playTrack(track('a'));
    await engine.setAccount(null);
    pending.resolve(playback('a'));
    await settle();
    expect(createAudio).not.toHaveBeenCalled();
    expect(state().userId).toBe(null);
    const restore = deferred<MusicTrack>();
    storage.set('qingzhou:music:v1:alice', JSON.stringify({ ids: ['a'] }));
    vi.mocked(client.track).mockReturnValueOnce(restore.promise);
    const restoring = engine.setAccount('alice');
    engine.playTrack(track('b'));
    await settle();
    restore.resolve(track('a'));
    await restoring;
    expect(state().activeId).toBe('b');
    expect(state().queue.map((t) => t.id)).toEqual(['b']);
  });

  it('survives corrupted or unavailable storage and StrictMode dispose/remount', async () => {
    const { engine, storage, state, audio } = setup();
    storage.set('qingzhou:music:v1:alice', '{invalid');
    await engine.setAccount('alice');
    expect(state().storageWarning).toBe(true);
    engine.playTrack(track('a'));
    await settle();
    engine.dispose();
    expect(audio.paused).toBe(true);
    await engine.setAccount('alice');
    expect(state().status).toBe('paused');
    engine.play();
    await settle();
    expect(state().status).toBe('playing');
    const unavailable = setup({
      storage: {
        getItem: () => {
          throw new Error('disabled');
        },
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {},
      },
    });
    await unavailable.engine.setAccount('a');
    unavailable.engine.playTrack(track('b'));
    await settle();
    expect(unavailable.state()).toMatchObject({ status: 'playing', storageWarning: true });
  });
});
