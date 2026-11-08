// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import type { MusicAccountAccess } from './account-service';
import type { KugouCredentials } from './account-store';
import { KugouMusicProvider, kugouTrackId } from './kugou-provider';

const hash = 'c'.repeat(32);
const id = kugouTrackId(hash, 12, 34);
const credentials = (): KugouCredentials => ({
  appId: 3116,
  connectedAt: Date.now(),
  device: { mid: 'd'.repeat(32), dev: 'D'.repeat(32), dfid: '-' },
  displayName: 'Listener',
  expiresAt: Date.now() + 100000,
  id: randomUUID(),
  token: 'test-private-token',
  userId: '12345',
});
const full = {
  status: 1,
  extName: 'mp3',
  timeLength: 240,
  url: ['http://fs.youthandroid2.kugou.com/full.mp3'],
};
const preview = {
  ...full,
  hash_offset: { start_ms: 30000, end_ms: 90000 },
  url: ['https://fsandroid.kugou.com/preview.mp3'],
};
function fixture() {
  const credential = credentials();
  const account: MusicAccountAccess = {
    credentials: vi.fn().mockResolvedValue(credential),
    expire: vi.fn(),
    isCurrent: vi.fn().mockResolvedValue(true),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v2/get_res_privilege/lite')
      return Response.json({
        status: 1,
        data: [{ hash, name: 'Song', info: { duration: 240000, filesize: 4000000 } }],
      });
    if (url.pathname === '/v5/url') return Response.json(full);
    return new Response(new Uint8Array([73, 68, 51]), {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  });
  return {
    account,
    credential,
    fetcher,
    provider: new KugouMusicProvider('alice', fetcher, account),
  };
}
it('uses only the linked account token and profile for granted full playback, keeping credentials server-side', async () => {
  const f = fixture();
  const result = await f.provider.resolve(id);
  expect(result.track).toMatchObject({ playbackKind: 'full', durationMs: 240000 });
  const call = f.fetcher.mock.calls.find(
    ([input]) => new URL(String(input)).pathname === '/v5/url',
  )!;
  const url = new URL(String(call[0]));
  expect(url.searchParams.get('IsFreePart')).toBe('0');
  expect(url.searchParams.get('appid')).toBe('3116');
  expect(url.searchParams.get('userid')).toBe('12345');
  expect(url.searchParams.get('token')).toBe(f.credential.token);
  expect(url.searchParams.get('mid')).toBe(f.credential.device.mid);
  expect(result.src).toContain('accountRevision=' + f.credential.id);
  expect(JSON.stringify(result)).not.toContain(f.credential.token);
});
it('falls back only to the normal public preview if the account is not entitled', async () => {
  const f = fixture();
  await f.provider.track(id);
  f.fetcher.mockClear();
  f.fetcher.mockImplementation(async (input) => {
    const url = new URL(String(input));
    return Response.json(
      url.searchParams.get('IsFreePart') === '0' ? { status: 0, url: [] } : preview,
    );
  });
  const result = await f.provider.resolve(id);
  expect(result.track).toMatchObject({ playbackKind: 'preview', durationMs: 60000 });
  expect(result.offsetMs).toBe(30000);
  const calls = f.fetcher.mock.calls.map(([input]) => new URL(String(input)));
  expect(calls).toHaveLength(2);
  expect(calls[1].searchParams.has('token')).toBe(false);
  expect(calls[1].searchParams.get('hash')).toBe(hash);
  expect(calls[1].searchParams.get('IsFreePart')).toBe('1');
});
it('expires an explicitly rejected token and does not retry protected playback or verification', async () => {
  const f = fixture();
  await f.provider.track(id);
  f.fetcher.mockClear();
  f.fetcher.mockResolvedValue(Response.json({ status: 0, error_msg: 'token expired' }));
  await expect(f.provider.resolve(id)).rejects.toThrow('MUSIC_ACCOUNT_EXPIRED');
  expect(f.account.expire).toHaveBeenCalledWith(f.credential.id);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.fetcher
    .mockReset()
    .mockResolvedValue(new Response('{}', { headers: { 'ssa-code': 'verify' } }));
  await expect(f.provider.resolve(id)).rejects.toThrow('MUSIC_ACCOUNT_VERIFICATION_REQUIRED');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it('rejects stale source revisions and a disconnect during media acquisition', async () => {
  const f = fixture();
  await expect(
    f.provider.stream(id, new Request('https://app.test?accountRevision=' + randomUUID())),
  ).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
  expect(f.fetcher).not.toHaveBeenCalled();
  vi.mocked(f.account.isCurrent).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    f.provider.stream(id, new Request('https://app.test?accountRevision=' + f.credential.id)),
  ).rejects.toThrow('MUSIC_ACCOUNT_CHANGED');
});
