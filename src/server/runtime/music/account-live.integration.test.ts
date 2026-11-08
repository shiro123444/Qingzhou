// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { KugouQrUpstream } from './account-upstream';

it.skipIf(process.env.KUGOU_LOGIN_LIVE !== '1')(
  'creates a genuine Kugou QR and observes waiting without claiming a logged-in session',
  async () => {
    const upstream = new KugouQrUpstream();
    const device = {
      mid: randomBytes(16).toString('hex'),
      dev: randomBytes(16).toString('hex').toUpperCase(),
      dfid: '-',
    };
    const result = await upstream.create(device);
    expect(Boolean(result.key)).toBe(true);
    const state = (await upstream.poll(result.key, device)).state;
    expect(state).toBe('waiting');
    await mkdir('.data/kugou-validation', { recursive: true });
    await writeFile(
      '.data/kugou-validation/account-live.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          profile: 'MoeKoe lite 3116',
          qrCreated: true,
          state,
        },
        null,
        2,
      ),
    );
  },
  30_000,
);
