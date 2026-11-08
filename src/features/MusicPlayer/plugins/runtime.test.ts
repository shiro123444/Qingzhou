import { type Context, type Plugin } from '@lobechat/cordis-foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type MusicLyrics } from '@/types/music';

import { AudioEngine } from '../engine';
import { type MusicPlayerPort } from '../ports';
import { lyricsForClip, lyricsPlugin } from './lyrics-plugin';
import { MusicPluginHost } from './runtime';
import { type LyricsPluginView, type LyricsViewSlot, type MusicLyricsSource } from './types';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
  vi.restoreAllMocks();
});

async function setup(plugin?: Plugin, storageOverride?: Pick<Storage, 'getItem' | 'setItem'>) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const client = {
    lyrics: vi.fn(async (trackId: string, _signal?: AbortSignal): Promise<MusicLyrics> => ({
      trackId,
      format: 'lrc',
      text: null,
    })),
    resolve: vi.fn(),
    search: vi.fn(),
    track: vi.fn(),
    uploadAudio: vi.fn(),
  };
  const engine = new AudioEngine({ storage, client });
  await engine.setAccount('alice');
  // Count actual engine watchers, independent of Cordis state/UI labels.
  let watchers = 0;
  const subscribe = engine.store.subscribe;
  vi.spyOn(engine.store, 'subscribe').mockImplementation((listener) => {
    watchers++;
    const off = subscribe(listener);
    let active = true;
    return () => {
      if (active) {
        active = false;
        watchers--;
        off();
      }
    };
  });
  const host = new MusicPluginHost(engine, { lyrics: plugin, storage: storageOverride ?? storage });
  cleanup.push(async () => {
    await host.stop();
    engine.dispose();
  });
  return { client, engine, host, state: host.store.getState, values, watchers: () => watchers };
}

function setOnline(engine: AudioEngine, id = 'online-a') {
  setTrack(engine, id);
  engine.store.setState({
    lyrics: {},
    queue: engine.store.getState().queue.map((track) => ({ ...track, source: 'kugou' })),
  });
}

function setTrack(engine: AudioEngine, id = 'a') {
  engine.store.setState({
    activeId: id,
    durationMs: 12_000,
    lyrics: {
      [id]: {
        lines: [
          { text: 'First', timeMs: 0 },
          { text: 'Second', timeMs: 2000 },
        ],
        text: '',
      },
    },
    queue: [
      { id, name: `${id}.mp3`, mimeType: 'audio/mpeg', size: 10, source: 'library', version: '1' },
    ],
    positionMs: 2300,
    status: 'playing',
  });
}

describe('native Cordis music plugins', () => {
  it('restores paused preview lyrics at the saved clip offset without starting audio', async () => {
    const { client, engine, host, state } = await setup();
    setOnline(engine);
    engine.store.setState({
      durationMs: 60000,
      offsetMs: 30000,
      positionMs: 2500,
      status: 'paused',
      queue: engine.store.getState().queue.map((track) => ({ ...track, playbackKind: 'preview' })),
    });
    client.track.mockResolvedValue(engine.store.getState().queue[0]);
    client.lyrics.mockImplementation(async (trackId) => ({
      trackId,
      format: 'lrc',
      text: '[00:25]First\n[00:32]Current',
    }));
    engine.flush();
    await engine.setAccount('bob');
    await engine.setAccount('alice');
    await host.start();
    await vi.waitFor(() => expect(state().lyrics?.status).toBe('ready'));
    expect(engine.store.getState()).toMatchObject({
      status: 'paused',
      offsetMs: 30000,
      positionMs: 2500,
      durationMs: 60000,
    });
    expect(state().lyrics).toMatchObject({
      currentLine: 1,
      positionMs: 2500,
      lines: [
        { text: 'First', timeMs: 0 },
        { text: 'Current', timeMs: 2000 },
      ],
    });
    expect(client.resolve).not.toHaveBeenCalled();
  });
  it('automatically fetches once, caches songs across switches and projects preview-relative seek', async () => {
    const { client, engine, host, state } = await setup();
    client.lyrics.mockImplementation(async (trackId) => ({
      trackId,
      format: 'lrc',
      text: '[00:25]Spanning the start\n[00:32]Inside clip\n[01:31]Outside clip',
    }));
    setOnline(engine);
    engine.store.setState({
      durationMs: 60000,
      offsetMs: 30000,
      positionMs: 2500,
      queue: engine.store.getState().queue.map((track) => ({ ...track, playbackKind: 'preview' })),
    });
    const seek = vi.spyOn(engine, 'seek');
    await host.start();
    await vi.waitFor(() => expect(state().lyrics?.status).toBe('ready'));
    expect(client.lyrics).toHaveBeenCalledTimes(1);
    expect(state().lyrics?.lines).toEqual([
      { text: 'Spanning the start', timeMs: 0 },
      { text: 'Inside clip', timeMs: 2000 },
    ]);
    expect(state().lyrics?.currentLine).toBe(1);
    state().lyrics!.seekLine(1);
    expect(seek).toHaveBeenCalledWith(2000);
    for (let positionMs = 0; positionMs < 1000; positionMs += 10)
      engine.store.setState({ positionMs });
    expect(client.lyrics).toHaveBeenCalledTimes(1);
    setOnline(engine, 'online-b');
    await vi.waitFor(() => expect(client.lyrics).toHaveBeenCalledTimes(2));
    setOnline(engine);
    await vi.waitFor(() => expect(state().lyrics?.status).toBe('ready'));
    expect(client.lyrics).toHaveBeenCalledTimes(2);
  });

  it('aborts late lyrics on track change, plugin unload and an account round trip', async () => {
    const { client, engine, host, state } = await setup();
    const pending: { signal?: AbortSignal; resolve: (result: MusicLyrics) => void }[] = [];
    client.lyrics.mockImplementation(
      (_trackId, signal) => new Promise((resolve) => pending.push({ signal, resolve })),
    );
    setOnline(engine, 'first');
    await host.start();
    expect(state().lyrics?.status).toBe('loading');
    setOnline(engine, 'second');
    expect(pending[0].signal?.aborted).toBe(true);
    pending[0].resolve({ trackId: 'first', format: 'lrc', text: '[00:00]Stale' });
    await Promise.resolve();
    expect(state().lyrics?.trackId).toBe('second');
    expect(state().lyrics?.lines).toEqual([]);
    const disabling = host.setEnabled('lyrics', false);
    expect(pending[1].signal?.aborted).toBe(true);
    pending[1].resolve({ trackId: 'second', format: 'lrc', text: '[00:00]Hidden' });
    await disabling;
    expect(state().lyrics).toBeNull();
    await host.setEnabled('lyrics', true);
    await engine.setAccount('bob');
    expect(pending[2].signal?.aborted).toBe(true);
    pending[2].resolve({ trackId: 'second', format: 'lrc', text: '[00:00]Other account' });
    await vi.waitFor(() => expect(state().userId).toBe('bob'));
    expect(state().lyrics?.lines ?? []).toEqual([]);
  });

  it('retries failed requests without stopping playback and restricts the lyric capability to the active track', async () => {
    let source!: MusicLyricsSource;
    const plugin: Plugin.Object = {
      ...lyricsPlugin,
      apply(ctx) {
        source = ctx.get('music.lyricsSource');
        return lyricsPlugin.apply(ctx, {});
      },
    };
    const { client, engine, host, state } = await setup(plugin);
    client.lyrics.mockRejectedValueOnce(new Error('unavailable'));
    setOnline(engine);
    await host.start();
    await vi.waitFor(() => expect(state().lyrics?.status).toBe('error'));
    const oldSource = source;
    await expect(source.get('another-track', new AbortController().signal)).rejects.toThrow(
      'PERMISSION_DENIED',
    );
    client.lyrics.mockResolvedValue({
      trackId: 'online-a',
      format: 'lrc',
      text: '[00:00]Recovered',
    });
    state().lyrics!.retry();
    await vi.waitFor(() => expect(state().lyrics?.status).toBe('ready'));
    expect(client.lyrics).toHaveBeenCalledTimes(2);
    expect(engine.store.getState().status).toBe('playing');
    await host.stop();
    await expect(oldSource.get('online-a', new AbortController().signal)).rejects.toThrow(
      'REVOKED',
    );
  });

  it('keeps an exact clip-start line and excludes the first unavailable timestamp', () => {
    expect(
      lyricsForClip(
        [
          { text: 'before', timeMs: 0 },
          { text: 'start', timeMs: 1000 },
          { text: 'end', timeMs: 2000 },
        ],
        1000,
        1000,
      ),
    ).toEqual([{ text: 'start', timeMs: 0 }]);
  });
  it('owns a single subscription, projects lyrics, and unloads without touching playback', async () => {
    const { engine, host, state, watchers } = await setup();
    const play = vi.spyOn(engine, 'play');
    const pause = vi.spyOn(engine, 'pause');
    const seek = vi.spyOn(engine, 'seek');
    setTrack(engine);
    await host.start();
    expect(state().status).toBe('active');
    expect(watchers()).toBe(2); // Account observer + account-scoped port.
    expect(state().lyrics).toMatchObject({ trackId: 'a', currentLine: 1, positionMs: 2300 });
    state().lyrics!.seekLine(1);
    expect(seek).toHaveBeenLastCalledWith(2000);
    await host.setEnabled('lyrics', false);
    expect(state()).toMatchObject({ enabled: false, status: 'disabled', lyrics: null });
    expect(watchers()).toBe(1);
    expect(engine.store.getState()).toMatchObject({ status: 'playing', activeId: 'a' });
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    await host.setEnabled('lyrics', true);
    await host.setEnabled('lyrics', true);
    expect(watchers()).toBe(2);
    await host.stop();
    expect(watchers()).toBe(0);
  });

  it('revokes old views and ports before async disposal and rejects non-seek commands', async () => {
    let port!: MusicPlayerPort;
    const plugin: Plugin.Object = {
      ...lyricsPlugin,
      apply(ctx) {
        port = ctx.get('music.player');
        return lyricsPlugin.apply(ctx, {});
      },
    };
    const { engine, host, state } = await setup(plugin);
    const seek = vi.spyOn(engine, 'seek');
    setTrack(engine);
    await host.start();
    const view = state().lyrics!;
    const oldPort = port;
    expect(() => port.command({ type: 'pause' })).toThrow('PERMISSION_DENIED');
    expect(() => port.command({ type: 'seek', value: Infinity })).toThrow('INVALID_COMMAND');
    setTrack(engine, 'b');
    view.seekLine(1);
    expect(seek).not.toHaveBeenCalled();
    const stopping = host.setEnabled('lyrics', false);
    expect(() => oldPort.command({ type: 'seek', value: 100 })).toThrow('REVOKED');
    await stopping;
    view.seekLine(1);
    expect(seek).not.toHaveBeenCalled();
  });

  it('persists preferences by account and permanently revokes a round-trip account session', async () => {
    let port!: MusicPlayerPort;
    const plugin: Plugin.Object = {
      ...lyricsPlugin,
      apply(ctx) {
        port = ctx.get('music.player');
        return lyricsPlugin.apply(ctx, {});
      },
    };
    const { engine, host, state } = await setup(plugin);
    await host.start();
    const alicePort = port;
    await host.setEnabled('lyrics', false);
    await engine.setAccount('bob');
    await vi.waitFor(() => expect(state().status).toBe('active'));
    expect(state()).toMatchObject({ userId: 'bob', enabled: true });
    const bobPort = port;
    await engine.setAccount('alice');
    expect(state()).toMatchObject({
      userId: 'alice',
      enabled: false,
      status: 'disabled',
      lyrics: null,
    });
    expect(() => alicePort.getSnapshot()).toThrow('REVOKED');
    expect(() => bobPort.getSnapshot()).toThrow('REVOKED');
    await host.stop();
    await host.start();
    expect(state().enabled).toBe(false);
  });

  it('survives StrictMode-style cleanup/setup with one live projection', async () => {
    const { engine, host, state, watchers } = await setup();
    const firstStart = host.start();
    const stopping = host.stop();
    const secondStart = host.start();
    await Promise.all([firstStart, stopping, secondStart]);
    expect(state().status).toBe('active');
    expect(watchers()).toBe(2);
    setTrack(engine);
    expect(state().lyrics?.trackId).toBe('a');
    await engine.setAccount(null);
    expect(state()).toMatchObject({ userId: null, lyrics: null, status: 'disabled' });
    expect(watchers()).toBe(1);
  });

  it('isolates late startup and projections from a previous account', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slots: LyricsViewSlot[] = [];
    let disposed = 0;
    let mounted = 0;
    const plugin: Plugin.Object = {
      name: 'delayed-lyrics',
      inject: ['music.lyrics'],
      apply(ctx: Context) {
        slots.push(ctx.get('music.lyrics'));
        mounted++;
        return mounted === 1
          ? gate.then(() => () => {
              disposed++;
            })
          : () => {
              disposed++;
            };
      },
    };
    const { engine, host, state } = await setup(plugin);
    const starting = host.start();
    expect(state().status).toBe('loading');
    await vi.waitFor(() => expect(mounted).toBe(1));
    await engine.setAccount('bob');
    await vi.waitFor(() => expect(state().status).toBe('active'));
    slots[0].publish({ trackId: 'stale' } as LyricsPluginView);
    expect(state().lyrics).toBeNull();
    release();
    await starting;
    expect(state()).toMatchObject({ userId: 'bob', status: 'active', lyrics: null });
    await host.stop();
    expect(disposed).toBe(2);
  });

  it('reports startup failure, retries through a fresh fiber and tolerates blocked storage', async () => {
    let attempts = 0;
    const plugin: Plugin.Object = {
      ...lyricsPlugin,
      apply(ctx) {
        if (++attempts === 1) throw new Error('test startup failure');
        return lyricsPlugin.apply(ctx, {});
      },
    };
    const { host, state, watchers } = await setup(plugin, {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    await host.start();
    expect(state()).toMatchObject({ status: 'error', storageWarning: true, lyrics: null });
    expect(watchers()).toBe(1);
    await host.retry('lyrics');
    expect(state().status).toBe('active');
    await host.setEnabled('lyrics', false);
    expect(state()).toMatchObject({ status: 'disabled', storageWarning: true });
    expect(watchers()).toBe(1);
  });
});
