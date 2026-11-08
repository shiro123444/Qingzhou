import { afterEach, describe, expect, it, vi } from 'vitest';

import { type MusicPlayback, type MusicTrack } from '@/types/music';

import { AudioEngine, type MusicTransport } from './engine';
import { createMusicPlayerPort, type MusicPlayerSession } from './ports';

const track = (id: string): MusicTrack => ({
  id,
  mimeType: 'audio/mpeg',
  name: `${id}.mp3`,
  size: 1000,
  source: 'library',
  version: 'private-version',
});
const playback = (id: string): MusicPlayback => ({
  src: `/api/runtime/music/tracks/${id}/stream`,
  track: track(id),
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
}

const engines: AudioEngine[] = [];
const sessions: MusicPlayerSession[] = [];
async function setup() {
  const audio = new TestAudio();
  const createAudio = vi.fn(() => audio as unknown as HTMLAudioElement);
  const client: MusicTransport = {
    resolve: vi.fn(async (id) => playback(id)),
    search: vi.fn(async () => []),
    track: vi.fn(async (id) => track(id)),
    uploadAudio: vi.fn(async () => track('upload')),
  };
  const engine = new AudioEngine({
    client,
    createAudio,
    storage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  });
  engines.push(engine);
  await engine.setAccount('alice');
  const session = createMusicPlayerPort(engine);
  sessions.push(session);
  return { audio, client, createAudio, engine, ...session };
}

afterEach(() => {
  sessions.splice(0).forEach((session) => session.dispose());
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks();
});

describe('account-bound MusicPlayerPort', () => {
  it('projects only current metadata and deeply freezes copies of tracks and lyric lines', async () => {
    const { audio, engine, port } = await setup();
    engine.enqueue([track('a'), track('private-queue-item')]);
    engine.importLyrics('a', '[00:01]First line\n[00:03]Second line');
    port.command({ type: 'play' });
    await settle();
    audio.metadata();
    audio.currentTime = 2;
    audio.emit('timeupdate');

    const snapshot = port.getSnapshot();
    expect(snapshot).toEqual({
      durationMs: 120_000,
      lyrics: {
        currentLine: 0,
        lines: [
          { text: 'First line', timeMs: 1000 },
          { text: 'Second line', timeMs: 3000 },
        ],
      },
      positionMs: 2000,
      offsetMs: 0,
      repeat: 'sequence',
      shuffle: false,
      status: 'playing',
      track: {
        id: 'a',
        mimeType: 'audio/mpeg',
        name: 'a.mp3',
        size: 1000,
        source: 'library',
        playbackKind: undefined,
      },
      userId: 'alice',
      volume: 0.8,
    });
    expect(Object.keys(port).sort()).toEqual([
      'command',
      'getPositionMs',
      'getSnapshot',
      'subscribe',
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/stream|private-version|private-queue-item/);
    expect(Object.isFrozen(port)).toBe(true);
    for (const value of [
      snapshot,
      snapshot.track,
      snapshot.lyrics,
      snapshot.lyrics.lines,
      ...snapshot.lyrics.lines,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(snapshot.track).not.toBe(engine.store.getState().queue[0]);
    expect(snapshot.lyrics.lines).not.toBe(engine.store.getState().lyrics.a.lines);
    expect(snapshot.lyrics.lines[0]).not.toBe(engine.store.getState().lyrics.a.lines[0]);
    expect(Reflect.set(snapshot.track!, 'name', 'changed')).toBe(false);
    expect(Reflect.set(snapshot.lyrics.lines[0], 'text', 'changed')).toBe(false);
    expect(engine.store.getState().queue[0].name).toBe('a.mp3');
    expect(engine.store.getState().lyrics.a.lines[0].text).toBe('First line');

    audio.currentTime = 4;
    audio.emit('timeupdate');
    expect(port.getSnapshot().lyrics.currentLine).toBe(1);
    expect(snapshot.lyrics.currentLine).toBe(0);
  });

  it('controls the existing engine while preserving a single media element', async () => {
    const { audio, createAudio, engine, port } = await setup();
    engine.enqueue([track('a'), track('b')]);
    port.command({ type: 'play' });
    await settle();
    audio.metadata();
    port.command({ type: 'setVolume', value: 0.25 });
    port.command({ type: 'seek', value: 2000 });
    expect(audio.volume).toBe(0.25);
    expect(audio.currentTime).toBe(2);
    port.command({ type: 'pause' });
    expect(port.getSnapshot().status).toBe('paused');
    port.command({ type: 'play' });
    await settle();
    expect(port.getSnapshot().status).toBe('playing');
    port.command({ type: 'next' });
    await settle();
    expect(port.getSnapshot().track?.id).toBe('b');
    port.command({ type: 'previous' });
    await settle();
    expect(port.getSnapshot().track?.id).toBe('a');
    expect(createAudio).toHaveBeenCalledTimes(1);
  });

  it('reads the precise media clock without publishing store updates and revokes it with the session', async () => {
    const { audio, engine, port, dispose } = await setup();
    engine.enqueue([track('clock')]);
    port.command({ type: 'play' });
    await settle();
    audio.metadata();
    const listener = vi.fn();
    port.subscribe(listener);
    const calls = listener.mock.calls.length;
    for (let frame = 0; frame < 60; frame++) {
      audio.currentTime = 1 + frame / 60;
      expect(port.getPositionMs()).toBeCloseTo(audio.currentTime * 1000);
    }
    expect(listener).toHaveBeenCalledTimes(calls);
    dispose();
    expect(() => port.getPositionMs()).toThrow('MUSIC_PLAYER_PORT_REVOKED');
  });

  it('strictly rejects unknown commands, extra keys and invalid values before invoking the engine', async () => {
    const { createAudio, engine, port } = await setup();
    const original = port.getSnapshot();
    const getter = vi.fn(() => 'play');
    const invalid = [
      null,
      undefined,
      'play',
      [],
      {},
      { type: 'dispose' },
      { type: 'play', value: undefined },
      { type: 'pause', engine },
      { type: 'play', [Symbol('extra')]: true },
      Object.create({ type: 'play' }),
      Object.defineProperty({}, 'type', { get: getter }),
      { type: 'seek' },
      { type: 'seek', value: '1000' },
      { type: 'seek', value: -1 },
      { type: 'seek', value: NaN },
      { type: 'seek', value: Infinity },
      { type: 'seek', value: 1, extra: true },
      { type: 'setVolume', value: -0.1 },
      { type: 'setVolume', value: 1.1 },
      { type: 'setVolume', value: Infinity },
    ];
    for (const command of invalid)
      expect(() => port.command(command)).toThrow('MUSIC_PLAYER_INVALID_COMMAND');
    expect(getter).not.toHaveBeenCalled();
    expect(createAudio).not.toHaveBeenCalled();
    expect(port.getSnapshot()).toBe(original);
    port.command({ type: 'setVolume', value: 0 });
    expect(port.getSnapshot().volume).toBe(0);
  });

  it('immediately subscribes and memoizes unchanged projected snapshots', async () => {
    const { engine, port } = await setup();
    const listener = vi.fn();
    const unsubscribe = port.subscribe(listener);
    const first = port.getSnapshot();
    expect(listener).toHaveBeenCalledExactlyOnceWith(first);
    expect(port.getSnapshot()).toBe(first);
    engine.enqueue([track('a')]);
    engine.store.setState({ error: true, storageWarning: true });
    expect(port.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
    port.command({ type: 'setVolume', value: 0.2 });
    const second = port.getSnapshot();
    expect(second).not.toBe(first);
    expect(listener).toHaveBeenLastCalledWith(second);
    engine.store.setState({ volume: 0.2 });
    expect(port.getSnapshot()).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    port.command({ type: 'setVolume', value: 0.3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates failing subscribers and never sends a stale reentrant snapshot', async () => {
    const { port } = await setup();
    port.subscribe(() => {
      throw new Error('plugin failure');
    });
    port.subscribe((snapshot) => {
      if (snapshot.volume === 0.2) port.command({ type: 'setVolume', value: 0.3 });
    });
    const listener = vi.fn();
    port.subscribe(listener);
    port.command({ type: 'setVolume', value: 0.2 });
    expect(listener.mock.calls.map(([snapshot]) => snapshot.volume)).toEqual([0.8, 0.3]);
  });

  it('disposes subscriptions without stopping shared playback', async () => {
    const { audio, engine, port } = await setup();
    engine.enqueue([track('a')]);
    port.command({ type: 'play' });
    await settle();
    const subscribe = engine.store.subscribe.bind(engine.store);
    const unsubscribe = vi.fn();
    vi.spyOn(engine.store, 'subscribe').mockImplementation((listener) => {
      const stop = subscribe(listener);
      return () => {
        unsubscribe();
        stop();
      };
    });
    const session = createMusicPlayerPort(engine);
    sessions.push(session);
    const listener = vi.fn();
    const stop = session.port.subscribe(listener);
    session.dispose();
    session.dispose();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    engine.setVolume(0.1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(false);
    expect(engine.store.getState().status).toBe('playing');
    expect(() => session.port.command({ type: 'pause' })).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(() => session.port.getSnapshot()).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(() => session.port.subscribe(vi.fn())).toThrow('MUSIC_PLAYER_PORT_REVOKED');
  });

  it('irreversibly revokes on an account round trip and never publishes another account', async () => {
    const { engine, port } = await setup();
    const listener = vi.fn();
    port.subscribe(listener);
    await engine.setAccount('bob');
    engine.enqueue([track('bob-only')]);
    await engine.setAccount('alice');
    expect(listener).toHaveBeenCalledTimes(1);
    for (const type of ['play', 'pause', 'previous', 'next'])
      expect(() => port.command({ type })).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(() => port.command({ type: 'seek', value: 0 })).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(() => port.command({ type: 'setVolume', value: 0 })).toThrow(
      'MUSIC_PLAYER_PORT_REVOKED',
    );
    expect(() => port.getSnapshot()).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(() => port.subscribe(vi.fn())).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    const replacement = createMusicPlayerPort(engine);
    sessions.push(replacement);
    replacement.port.command({ type: 'setVolume', value: 0.4 });
    expect(replacement.port.getSnapshot().userId).toBe('alice');
    expect(replacement.port.getSnapshot().volume).toBe(0.4);
  });

  it('rechecks account ownership after inspecting an untrusted command object', async () => {
    const { engine, port } = await setup();
    const command = new Proxy(
      { type: 'setVolume', value: 0.1 },
      {
        ownKeys(target) {
          engine.store.setState({ userId: 'bob' });
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(() => port.command(command)).toThrow('MUSIC_PLAYER_PORT_REVOKED');
    expect(engine.store.getState().volume).toBe(0.8);
  });

  it('preserves existing cancellation when pausing asynchronous playback resolution', async () => {
    const { audio, client, engine, port } = await setup();
    const pending = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(pending.promise);
    engine.enqueue([track('a')]);
    port.command({ type: 'play' });
    port.command({ type: 'pause' });
    pending.resolve(playback('a'));
    await settle();
    audio.metadata();
    expect(audio.play).not.toHaveBeenCalled();
    expect(port.getSnapshot().status).toBe('paused');
  });

  it('revokes on engine teardown and lets its cancellation reject late playback', async () => {
    const { audio, client, createAudio, engine, port } = await setup();
    const pending = deferred<MusicPlayback>();
    vi.mocked(client.resolve).mockReturnValueOnce(pending.promise);
    engine.enqueue([track('a')]);
    port.command({ type: 'play' });
    const signal = vi.mocked(client.resolve).mock.calls[0][1]!;
    engine.dispose();
    pending.resolve(playback('a'));
    await settle();
    expect(signal.aborted).toBe(true);
    expect(createAudio).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(() => port.command({ type: 'play' })).toThrow('MUSIC_PLAYER_PORT_REVOKED');
  });
});
