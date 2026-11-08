import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';

import music from '@/locales/default/music';
import { musicAccountClient } from '@/services/music-account';

import KugouAccount from './KugouAccount';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows a readable QR login with phone-confirmation guidance and no credential form', async () => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  vi.spyOn(musicAccountClient, 'status').mockResolvedValue({
    revision: '0',
    state: 'disconnected',
  });
  vi.spyOn(musicAccountClient, 'cancel').mockResolvedValue({
    revision: '0',
    state: 'disconnected',
  });
  vi.spyOn(musicAccountClient, 'start').mockResolvedValue({
    challengeId: 'd7753797-572d-490e-b151-d78248f531e7',
    expiresAt: Date.now() + 120_000,
    pollAfterMs: 2000,
    qrUrl: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=test-only',
  });
  render(
    <I18nextProvider i18n={i18n}>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <KugouAccount userId="listener" onBeforeDisconnect={vi.fn()} onChanged={vi.fn()} />
      </ConfigProvider>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: music.kugouAccount }));
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
  expect(await screen.findByText(music.kugouQrScan)).toBeVisible();
  const qr = screen.getByRole('img', { name: music.kugouQr });
  expect(qr.querySelector('svg')).toBeInTheDocument();
  expect(screen.getByText(music.kugouQrHint)).toBeVisible();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
