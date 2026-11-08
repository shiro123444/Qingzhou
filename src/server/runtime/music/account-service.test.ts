// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { MusicAccountService } from './account-service';
import type { MusicAccountRecord, MusicAccountStore, StoredMusicAccount } from './account-store';
import type { KugouLoginUpstream } from './account-upstream';

class MemoryStore implements MusicAccountStore {
  value?: StoredMusicAccount;
  async read() {
    return structuredClone(this.value);
  }
  async save(record: MusicAccountRecord, expected: string | null) {
    if ((this.value?.revision ?? null) !== expected) return;
    this.value = structuredClone({ record, revision: randomUUID() });
    return this.read();
  }
}
function fixture() {
  let now = 1_794_120_000_000;
  const store = new MemoryStore();
  const upstream: KugouLoginUpstream = {
    create: vi.fn().mockResolvedValue({ key: 'test-qr-key' }),
    poll: vi.fn().mockResolvedValue({ state: 'waiting' }),
  };
  const service = new MusicAccountService(store, upstream, () => now);
  const accepted = () => ({
    state: 'connected' as const,
    token: 'private-test-token',
    userId: '12345',
    displayName: 'Listener',
    expiresAt: now + 100_000,
  });
  return {
    accepted,
    service,
    store,
    upstream,
    advance: (ms = 2000) => {
      now += ms;
    },
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('per-account Kugou login lifecycle', () => {
  it('shows a scan challenge, throttles polling, and never returns provider credentials', async () => {
    const f = fixture();
    const status = await f.service.status();
    const login = await f.service.start();
    expect(login.qrUrl).toMatch(/^https:\/\/h5\.kugou\.com\//u);
    expect(login.expiresAt).toBeGreaterThan(0);
    expect((await f.service.status()).revision).toBe(status.revision);
    expect((await f.service.poll(login.challengeId)).state).toBe('waiting');
    await f.service.poll(login.challengeId);
    expect(f.upstream.poll).toHaveBeenCalledTimes(1);
    f.advance();
    vi.mocked(f.upstream.poll).mockResolvedValue({ state: 'scanned' });
    expect((await f.service.poll(login.challengeId)).state).toBe('scanned');
    expect((await f.service.status()).revision).toBe(status.revision);
    f.advance();
    vi.mocked(f.upstream.poll).mockResolvedValue(f.accepted());
    const connected = await f.service.poll(login.challengeId);
    expect(connected).toMatchObject({
      state: 'connected',
      account: { state: 'connected', displayName: 'Listener' },
    });
    expect(JSON.stringify(connected)).not.toMatch(/private-test-token|test-qr-key|12345/u);
    expect((await f.service.credentials())?.token).toBe('private-test-token');
    expect((await f.service.credentials())?.device).toEqual(
      vi.mocked(f.upstream.create).mock.calls[0][0],
    );
    expect((await f.service.status()).revision).not.toBe(status.revision);
  });

  it.each(['cancel', 'disconnect'] as const)(
    'rejects an authorization response arriving after %s',
    async (operation) => {
      const f = fixture();
      const login = await f.service.start();
      const result = deferred<Awaited<ReturnType<KugouLoginUpstream['poll']>>>();
      vi.mocked(f.upstream.poll).mockReturnValue(result.promise);
      const pending = f.service.poll(login.challengeId);
      await vi.waitFor(() => expect(f.upstream.poll).toHaveBeenCalledOnce());
      if (operation === 'cancel') await f.service.cancel(login.challengeId);
      else await f.service.disconnect();
      result.resolve(f.accepted());
      expect((await pending).state).toBe('cancelled');
      expect(await f.service.credentials()).toBeUndefined();
      expect(JSON.stringify(f.store.value)).not.toContain('private-test-token');
    },
  );

  it('does not resurrect a challenge whose creation completes after disconnect', async () => {
    const f = fixture();
    const result = deferred<{ key: string }>();
    vi.mocked(f.upstream.create).mockReturnValue(result.promise);
    const pending = f.service.start();
    await vi.waitFor(() => expect(f.upstream.create).toHaveBeenCalledOnce());
    await f.service.disconnect();
    result.resolve({ key: 'late-key' });
    await expect(pending).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
    expect(f.store.value?.record.pending).toBeUndefined();
  });

  it('expires tokens, prevents an old failure from expiring a new connection, and deletes all secret fields on disconnect', async () => {
    const f = fixture();
    const login = await f.service.start();
    vi.mocked(f.upstream.poll).mockResolvedValue(f.accepted());
    await f.service.poll(login.challengeId);
    const old = (await f.service.credentials())!.id;
    const second = await f.service.start();
    await f.service.poll(second.challengeId);
    const current = (await f.service.credentials())!.id;
    await f.service.expire(old);
    expect(await f.service.isCurrent(current)).toBe(true);
    f.advance(100_001);
    expect(await f.service.credentials()).toBeUndefined();
    expect((await f.service.status()).state).toBe('expired');
    await f.service.disconnect();
    expect(f.store.value?.record).toEqual(expect.objectContaining({ state: 'disconnected' }));
    expect(f.store.value?.record.connection).toBeUndefined();
    expect(f.store.value?.record.pending).toBeUndefined();
  });

  it('isolates another Qingzhou account challenge and expires unscanned QR codes', async () => {
    const alice = fixture(),
      bob = fixture();
    const login = await alice.service.start();
    expect((await bob.service.poll(login.challengeId)).state).toBe('cancelled');
    expect(bob.upstream.poll).not.toHaveBeenCalled();
    alice.advance(180_001);
    expect((await alice.service.poll(login.challengeId)).state).toBe('expired');
    expect(alice.upstream.poll).not.toHaveBeenCalled();
    expect(alice.store.value?.record.pending).toBeUndefined();
  });
});
