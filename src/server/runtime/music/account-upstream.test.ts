// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { KugouQrUpstream } from './account-upstream';

const device = { mid: 'a'.repeat(32), dev: 'A'.repeat(32), dfid: '-' };
it('uses the matching MoeKoe lite QR profile and a fixed HTTPS upstream without forwarding browser cookies', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ status: 1, data: { qrcode: 'test-login-key' } }))
    .mockResolvedValueOnce(Response.json({ status: 1, data: { status: 2 } }))
    .mockResolvedValueOnce(
      Response.json({
        status: 1,
        data: { status: 4, token: 'test-token', userid: 12345, nickname: 'Listener' },
      }),
    );
  const upstream = new KugouQrUpstream(fetcher, () => 1_794_120_000_000);
  const created = await upstream.create(device);
  const url = fetcher.mock.calls[0][0] as URL;
  expect(url.origin).toBe('https://login-user.kugou.com');
  expect(url.searchParams.get('qrcode_txt')).toContain('appid=3116&');
  expect(url.searchParams.get('signature')).toMatch(/^[a-f\d]{32}$/u);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('cookie')).toBe(false);
  expect((await upstream.poll(created.key, device)).state).toBe('scanned');
  const pollUrl = fetcher.mock.calls[1][0] as URL;
  expect(pollUrl.searchParams.get('appid')).toBe('3116');
  expect(pollUrl.searchParams.get('dev')).toBe(device.dev);
  expect(await upstream.poll(created.key, device)).toMatchObject({
    state: 'connected',
    userId: '12345',
    displayName: 'Listener',
    expiresAt: 1_794_120_000_000 + 30 * 86400_000,
  });
});
it('surfaces verification challenges, bounds responses, and rejects incomplete authorization', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}', { headers: { 'ssa-code': 'challenge' } }))
    .mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': '100000' } }))
    .mockResolvedValueOnce(Response.json({ status: 1, data: { status: 4, userid: 123 } }));
  const upstream = new KugouQrUpstream(fetcher);
  await expect(upstream.create(device)).rejects.toThrow('MUSIC_ACCOUNT_VERIFICATION_REQUIRED');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(upstream.create(device)).rejects.toThrow('MUSIC_ACCOUNT_UNAVAILABLE');
  await expect(upstream.poll('key', device)).rejects.toThrow('MUSIC_ACCOUNT_UNAVAILABLE');
});
