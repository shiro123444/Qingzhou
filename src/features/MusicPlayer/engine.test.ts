import { afterEach, describe, expect, it, vi } from 'vitest';

import { type MusicPlayback, type MusicTrack } from '@/types/music';

import { AudioEngine, type MusicTransport } from './engine';

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
  it('bounds the queue and rejects invalid lyrics without replacing existing lines', async () => {
    const { engine, state } = setup();
    await engine.setAccount('alice');
    engine.enqueue(Array.from({ length: 110 }, (_, index) => track(String(index))));
    expect(state().queue).toHaveLength(100);
    engine.importLyrics('0', '[00:01]original');
    expect(() => engine.importLyrics('0', 'untimed text')).toThrow('LRC_EMPTY');
    expect(state().lyrics['0'].lines[0].text).toBe('original');
    engine.setRepeat('list');
    engine.playTrack(track('0'));
    await settle();
    engine.previous();
    await settle();
    expect(state().activeId).toBe('99');
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
