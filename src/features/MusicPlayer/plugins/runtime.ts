import { Context, type Plugin } from '@lobechat/cordis-foundation';
import { createStore } from 'zustand/vanilla';

import { type AudioEngine } from '../engine';
import {
  createMusicPlayerPort,
  type MusicPlayerListener,
  type MusicPlayerPort,
  type MusicPlayerSession,
} from '../ports';
import { lyricsPlugin } from './lyrics-plugin';
import { type LyricsPluginView, type LyricsViewSlot, type MusicPluginState } from './types';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface Activation {
  context: Context;
  live: boolean;
  session: MusicPlayerSession;
}

const initialState = (): MusicPluginState => ({
  enabled: true,
  lyrics: null,
  status: 'disabled',
  storageWarning: false,
  userId: null,
});
const preferenceKey = (userId: string) => `qingzhou:music:plugins:v1:${encodeURIComponent(userId)}`;
// Cordis exports an ambient const enum, unavailable to isolatedModules consumers.
const CORDIS_ACTIVE = 2;

/** Owns browser-native Cordis lifetimes. Only application-bundled plugins can be mounted. */
export class MusicPluginHost {
  readonly store = createStore<MusicPluginState>()(initialState);
  private activation?: Activation;
  private running = false;
  private unsubscribe?: () => void;
  private readonly pendingCleanup = new Set<Promise<void>>();

  constructor(
    private readonly engine: AudioEngine,
    private readonly options: { lyrics?: Plugin; storage?: PreferenceStorage | null } = {},
  ) {}

  private storage() {
    return this.options.storage === undefined ? globalThis.localStorage : this.options.storage;
  }

  private readEnabled(userId: string) {
    try {
      const raw = this.storage()?.getItem(preferenceKey(userId));
      if (!raw) return true;
      const data: unknown = JSON.parse(raw);
      if (
        !data ||
        typeof data !== 'object' ||
        !('version' in data) ||
        data.version !== 1 ||
        !('lyrics' in data) ||
        typeof data.lyrics !== 'boolean'
      )
        throw new Error('INVALID_PREFERENCE');
      return data.lyrics;
    } catch {
      this.store.setState({ storageWarning: true });
      return true;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.engine.store.subscribe((state) => {
      if (state.userId !== this.store.getState().userId) void this.switchAccount(state.userId);
    });
    return this.switchAccount(this.engine.store.getState().userId);
  }

  /** Revocation is synchronous; Cordis may finish draining asynchronous effects afterward. */
  stop(): Promise<void> {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.retire();
    this.store.setState(initialState());
    return Promise.all(this.pendingCleanup).then(() => {});
  }

  private retire() {
    const activation = this.activation;
    this.activation = undefined;
    if (!activation) return;
    activation.live = false;
    activation.session.dispose();
    // Root disposal restarts Cordis's root fiber. Discard the context; never reuse it.
    const cleanup = Promise.resolve(activation.context.fiber.dispose()).then(
      () => {},
      () => {},
    );
    this.pendingCleanup.add(cleanup);
    void cleanup.finally(() => this.pendingCleanup.delete(cleanup));
  }

  private async switchAccount(userId: string | null) {
    this.retire();
    this.store.setState({ ...initialState(), userId });
    if (!userId || !this.running) return;
    const enabled = this.readEnabled(userId);
    this.store.setState({ enabled });
    if (enabled) await this.activate();
  }

  async setEnabled(id: 'lyrics', enabled: boolean) {
    if (id !== 'lyrics' || !this.running || !this.store.getState().userId) return;
    const state = this.store.getState();
    try {
      this.storage()?.setItem(
        preferenceKey(state.userId!),
        JSON.stringify({ lyrics: enabled, version: 1 }),
      );
      this.store.setState({ storageWarning: false });
    } catch {
      this.store.setState({ storageWarning: true });
    }
    if (state.enabled === enabled && (state.status === 'active' || state.status === 'loading'))
      return;
    this.retire();
    this.store.setState({ enabled, lyrics: null, status: 'disabled' });
    if (enabled) await this.activate();
    else await Promise.all(this.pendingCleanup);
  }

  async retry(id: 'lyrics') {
    if (
      id !== 'lyrics' ||
      !this.running ||
      !this.store.getState().enabled ||
      !this.store.getState().userId
    )
      return;
    this.retire();
    await this.activate();
  }

  private async activate() {
    const context = new Context();
    const activation: Activation = {
      context,
      live: true,
      session: createMusicPlayerPort(this.engine),
    };
    this.activation = activation;
    this.store.setState({ lyrics: null, status: 'loading' });
    const isCurrent = () => this.running && activation.live && this.activation === activation;
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error('MUSIC_PLUGIN_REVOKED');
    };
    const port: MusicPlayerPort = Object.freeze({
      command: (input: unknown) => {
        assertCurrent();
        if (
          !input ||
          typeof input !== 'object' ||
          Object.getOwnPropertyDescriptor(input, 'type')?.value !== 'seek'
        ) {
          throw new Error('MUSIC_PLUGIN_PERMISSION_DENIED');
        }
        activation.session.port.command(input);
      },
      getSnapshot: () => {
        assertCurrent();
        return activation.session.port.getSnapshot();
      },
      subscribe: (listener: MusicPlayerListener) => {
        assertCurrent();
        return activation.session.port.subscribe((snapshot) => {
          if (isCurrent()) listener(snapshot);
        });
      },
    });
    const slot: LyricsViewSlot = Object.freeze({
      clear: () => {
        if (isCurrent()) this.store.setState({ lyrics: null });
      },
      publish: (lyrics: LyricsPluginView) => {
        if (isCurrent()) this.store.setState({ lyrics });
      },
    });
    try {
      context.provide('music.player', port);
      context.provide('music.lyrics', slot);
      const fiber = context.plugin(this.options.lyrics ?? lyricsPlugin);
      await fiber;
      if (!isCurrent()) return;
      if (fiber.state !== CORDIS_ACTIVE) throw new Error('MUSIC_PLUGIN_NOT_ACTIVE');
      this.store.setState({ status: 'active' });
    } catch {
      if (!isCurrent()) return;
      this.retire();
      this.store.setState({ lyrics: null, status: 'error' });
    }
  }
}
