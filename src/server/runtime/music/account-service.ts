import { randomBytes, randomUUID } from 'node:crypto';

import type {
  MusicAccountLogin,
  MusicAccountPoll,
  MusicAccountStatus,
} from '@/types/music-account';

import type {
  KugouCredentials,
  MusicAccountRecord,
  MusicAccountStore,
  StoredMusicAccount,
} from './account-store';
import { type KugouLoginUpstream, KugouQrUpstream } from './account-upstream';
import { MusicError } from './contracts';
import { clearKugouLibraryCache, KugouLibraryProvider } from './library-provider';

const POLL_MS = 2000;
const QR_LIFETIME_MS = 180_000;
const empty = (): MusicAccountRecord => ({
  accountRevision: 'disconnected',
  state: 'disconnected',
  version: 1,
});
const dto = (record: MusicAccountRecord): MusicAccountStatus => ({
  ...(record.state === 'connected' && record.connection
    ? {
        connectedAt: record.connection.connectedAt,
        displayName: record.connection.displayName,
        expiresAt: record.connection.expiresAt,
      }
    : {}),
  revision: record.accountRevision,
  state: record.state,
});
export interface MusicAccountAccess {
  credentials: (signal?: AbortSignal) => Promise<KugouCredentials | undefined>;
  expire: (connectionId: string) => Promise<void>;
  isCurrent: (connectionId: string) => Promise<boolean>;
}

export class MusicAccountService implements MusicAccountAccess {
  constructor(
    private store: MusicAccountStore,
    private upstream: KugouLoginUpstream = new KugouQrUpstream(),
    private now = Date.now,
  ) {}

  private async current(): Promise<StoredMusicAccount | undefined> {
    let saved = await this.store.read();
    if (saved?.record.connection && saved.record.connection.expiresAt <= this.now()) {
      await this.expire(saved.record.connection.id);
      saved = await this.store.read();
    }
    return saved;
  }
  async status() {
    return dto((await this.current())?.record ?? empty());
  }
  async credentials(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const saved = await this.current();
    signal?.throwIfAborted();
    return saved?.record.state === 'connected' ? saved.record.connection : undefined;
  }
  async isCurrent(connectionId: string) {
    return (await this.credentials())?.id === connectionId;
  }
  async expire(connectionId: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await this.store.read();
      if (saved?.record.connection?.id !== connectionId) return;
      const { connection: _connection, ...rest } = saved.record;
      if (
        await this.store.save(
          { ...rest, accountRevision: randomUUID(), state: 'expired' },
          saved.revision,
        )
      ) {
        clearKugouLibraryCache(connectionId);
        return;
      }
    }
    throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
  }

  async start(signal?: AbortSignal): Promise<MusicAccountLogin> {
    signal?.throwIfAborted();
    const saved = await this.current();
    const challengeId = randomUUID();
    const pending = {
      device: {
        dev: randomBytes(16).toString('hex').toUpperCase(),
        dfid: '-',
        mid: randomBytes(16).toString('hex'),
      },
      expiresAt: this.now() + QR_LIFETIME_MS,
      id: challengeId,
      lastPollAt: 0,
      state: 'waiting' as const,
    };
    // Reserve before network IO. Closing the panel/disconnecting during creation
    // invalidates this revision, so a late upstream response cannot resurrect it.
    const reserved = await this.store.save(
      { ...(saved?.record ?? empty()), pending },
      saved?.revision ?? null,
    );
    if (!reserved) throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
    try {
      const { key } = await this.upstream.create(pending.device, signal);
      signal?.throwIfAborted();
      const ready = await this.store.save(
        { ...reserved.record, pending: { ...pending, key } },
        reserved.revision,
      );
      if (!ready) throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
      return {
        challengeId,
        expiresAt: pending.expiresAt,
        pollAfterMs: POLL_MS,
        qrUrl: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`,
      };
    } catch (error) {
      await this.cancel(challengeId);
      throw error;
    }
  }

  async poll(challengeId: string, signal?: AbortSignal): Promise<MusicAccountPoll> {
    signal?.throwIfAborted();
    const saved = await this.current();
    const pending = saved?.record.pending;
    if (!saved || pending?.id !== challengeId) return { pollAfterMs: POLL_MS, state: 'cancelled' };
    if (pending.expiresAt <= this.now()) {
      await this.cancel(challengeId);
      return { pollAfterMs: POLL_MS, state: 'expired' };
    }
    if (!pending.key || (pending.lastPollAt > 0 && this.now() - pending.lastPollAt < POLL_MS))
      return { pollAfterMs: POLL_MS, state: pending.state };
    const reserved = await this.store.save(
      { ...saved.record, pending: { ...pending, lastPollAt: this.now() } },
      saved.revision,
    );
    if (!reserved) return { pollAfterMs: POLL_MS, state: pending.state };
    const result = await this.upstream.poll(pending.key, pending.device, signal);
    signal?.throwIfAborted();
    const { pending: _pending, ...withoutPending } = reserved.record;
    let next: MusicAccountRecord;
    if (result.state === 'connected') {
      if (!result.token || !result.userId || !result.expiresAt || result.expiresAt <= this.now())
        throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
      const connectionId = randomUUID();
      next = {
        ...withoutPending,
        accountRevision: connectionId,
        state: 'connected',
        connection: {
          appId: 3116,
          connectedAt: this.now(),
          device: pending.device,
          displayName: result.displayName || '酷狗用户',
          expiresAt: result.expiresAt,
          id: connectionId,
          token: result.token,
          userId: result.userId,
        },
      };
    } else if (result.state === 'expired') next = withoutPending;
    else
      next = { ...reserved.record, pending: { ...reserved.record.pending!, state: result.state } };
    const committed = await this.store.save(next, reserved.revision);
    if (!committed) return { pollAfterMs: POLL_MS, state: 'cancelled' };
    if (result.state === 'connected' && reserved.record.connection)
      clearKugouLibraryCache(reserved.record.connection.id);
    return {
      ...(result.state === 'connected' ? { account: dto(next) } : {}),
      pollAfterMs: POLL_MS,
      state: result.state,
    };
  }

  async cancel(challengeId: string): Promise<MusicAccountStatus> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await this.current();
      if (saved?.record.pending?.id !== challengeId) return dto(saved?.record ?? empty());
      const { pending: _pending, ...record } = saved.record;
      if (await this.store.save(record, saved.revision)) return dto(record);
    }
    throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
  }

  async disconnect(): Promise<MusicAccountStatus> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const saved = await this.store.read();
      const record = { ...empty(), accountRevision: randomUUID() };
      if (await this.store.save(record, saved?.revision ?? null)) {
        if (saved?.record.connection) clearKugouLibraryCache(saved.record.connection.id);
        return dto(record);
      }
    }
    throw new MusicError('MUSIC_ACCOUNT_CHANGED', 409);
  }
  library(page = 1, signal?: AbortSignal) {
    return new KugouLibraryProvider(this).library(page, signal);
  }
  playlist(id: string, page = 1, signal?: AbortSignal) {
    return new KugouLibraryProvider(this).playlist(id, page, signal);
  }
  playlistCover(id: string, request: Request) {
    return new KugouLibraryProvider(this).playlistCover(id, request);
  }
}
