import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { KugouDevice } from './account-store';
import { MusicError } from './contracts';

const envelope = z.object({
  data: z
    .object({
      expire_time: z.coerce.number().finite().optional().catch(undefined),
      expires: z.coerce.number().finite().optional().catch(undefined),
      nickname: z.string().max(2000).optional(),
      qrcode: z
        .string()
        .regex(/^[\w-]{1,256}$/u)
        .optional(),
      status: z.coerce.number().int().optional(),
      token: z.string().min(1).max(4096).optional(),
      userid: z.union([z.string().regex(/^\d{1,20}$/u), z.number().int().positive()]).optional(),
    })
    .optional(),
  status: z.coerce.number().int(),
});
export interface KugouLoginUpstream {
  create: (device: KugouDevice, signal?: AbortSignal) => Promise<{ key: string }>;
  poll: (
    key: string,
    device: KugouDevice,
    signal?: AbortSignal,
  ) => Promise<{
    displayName?: string;
    expiresAt?: number;
    state: 'waiting' | 'scanned' | 'connected' | 'expired';
    token?: string;
    userId?: string;
  }>;
}

/** Minimal QR login from KuGouMusicApi (MIT); verification challenges are surfaced, never simulated. */
export class KugouQrUpstream implements KugouLoginUpstream {
  constructor(
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async request(
    path: string,
    device: KugouDevice,
    extra: Record<string, string | number>,
    signal?: AbortSignal,
  ) {
    const params: Record<string, string | number> = {
      appid: 3116,
      clienttime: Math.floor(this.now() / 1000),
      clientver: 11440,
      dfid: device.dfid,
      mid: device.mid,
      uuid: '-',
      ...extra,
    };
    const salt = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
    params.signature = createHash('md5')
      .update(
        salt +
          Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join('') +
          salt,
      )
      .digest('hex');
    const url = new URL('https://login-user.kugou.com' + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await this.fetcher(url, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'clienttime': String(params.clienttime),
        'dfid': device.dfid,
        'mid': device.mid,
      },
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12_000)]),
    });
    if (
      !response.ok ||
      response.headers.has('ssa-code') ||
      Number(response.headers.get('content-length')) > 64 * 1024
    ) {
      await response.body?.cancel();
      throw new MusicError(
        response.headers.has('ssa-code')
          ? 'MUSIC_ACCOUNT_VERIFICATION_REQUIRED'
          : 'MUSIC_ACCOUNT_UNAVAILABLE',
        502,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) {
          await reader.cancel();
          throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = envelope.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (result.status !== 1 || !result.data) throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
    return result.data;
  }
  async create(device: KugouDevice, signal?: AbortSignal) {
    const data = await this.request(
      '/v2/qrcode',
      device,
      {
        appid: 1001,
        plat: 4,
        qrcode_txt: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&',
        srcappid: 2919,
        type: 1,
      },
      signal,
    );
    if (!data.qrcode) throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
    return { key: data.qrcode };
  }
  async poll(key: string, device: KugouDevice, signal?: AbortSignal) {
    const data = await this.request(
      '/v2/get_userinfo_qrcode',
      device,
      { appid: 3116, dev: device.dev, plat: 4, qrcode: key, srcappid: 2919 },
      signal,
    );
    if (data.status === 4) {
      if (!data.token || !data.userid || String(data.userid) === '0')
        throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
      // An upstream absolute expiry is preferred. Otherwise a local 30-day ceiling
      // limits this linked session; an earlier token rejection still expires it immediately.
      const maxExpiry = this.now() + 30 * 24 * 60 * 60 * 1000;
      const rawExpiry = data.expire_time || data.expires || 0;
      const explicitExpiry =
        rawExpiry > 1e12 ? rawExpiry : rawExpiry > this.now() / 1000 ? rawExpiry * 1000 : 0;
      return {
        displayName: (data.nickname || '酷狗用户').slice(0, 200),
        expiresAt: Math.min(explicitExpiry || maxExpiry, maxExpiry),
        state: 'connected' as const,
        token: data.token,
        userId: String(data.userid),
      };
    }
    if (data.status === 1) return { state: 'waiting' as const };
    if (data.status === 2) return { state: 'scanned' as const };
    if (data.status === 0) return { state: 'expired' as const };
    throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 502);
  }
}
