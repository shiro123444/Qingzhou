// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import QrCodeAuth from './QrCodeAuth';

const mocks = vi.hoisted(() => ({ get: vi.fn(), poll: vi.fn() }));
vi.mock('@/services/agentBotProvider', () => ({
  agentBotProviderService: { wechatGetQrCode: mocks.get, wechatPollQrStatus: mocks.poll },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd', async (original) => ({
  ...(await original<typeof import('antd')>()),
  QRCode: () => <div>QR</div>,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('WeChat scan lifecycle', () => {
  it('ignores a late authorization response after leaving the page', async () => {
    vi.useFakeTimers();
    mocks.get.mockResolvedValue({ qrcode: 'code', qrcode_img_content: 'image' });
    let confirm!: (value: unknown) => void;
    mocks.poll.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const onAuthenticated = vi.fn();
    const view = render(<QrCodeAuth onAuthenticated={onAuthenticated} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'channel.wechatScanToConnect' }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      confirm({ status: 'confirmed', bot_token: 'test-only', ilink_bot_id: 'bot' });
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
  it('does not start polling if the QR request resolves after unmount', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<QrCodeAuth onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'channel.wechatScanToConnect' }));
    view.unmount();
    await act(async () => {
      resolve({ qrcode: 'stale', qrcode_img_content: 'image' });
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
  });
});
