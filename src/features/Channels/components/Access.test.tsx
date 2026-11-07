// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAccessSettings } from '@/types/channel';

import ChannelAccess from './Access';

const mocks = vi.hoisted(() => ({
  challenge: vi.fn(),
  list: vi.fn(),
  permissions: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'test-user' } }),
}));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    channelIdentity: {
      createChallenge: { mutate: mocks.challenge },
      list: { query: mocks.list },
      revoke: { mutate: mocks.revoke },
      updatePermissions: { mutate: mocks.permissions },
    },
  },
}));

const settings: ChannelAccessSettings = {
  allowFrom: [],
  channelIdentity: { requireBinding: false },
  dmPolicy: 'open',
  groupAllowFrom: [],
  groupPolicy: 'open',
};
const renderAccess = (enabled = true, providerId = 'first') => {
  const cache = new Map();
  const view = (id: string) => (
    <MemoryRouter>
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <App>
          <ChannelAccess
            configurationUrl="/agent/a/channel"
            enabled={enabled}
            key={id}
            providerId={id}
            settings={settings}
          />
        </App>
      </SWRConfig>
    </MemoryRouter>
  );
  const result = render(view(providerId));
  return { ...result, switchProvider: (id: string) => result.rerender(view(id)) };
};

describe('channel identity access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({
      identities: [],
      permissions: { requireBinding: false },
      supported: true,
    });
    mocks.challenge.mockResolvedValue({
      code: 'TESTCODE',
      command: '/bind TESTCODE',
      expiresAt: Date.now() + 60_000,
    });
    mocks.permissions.mockResolvedValue({ ok: true });
  });

  it('keeps binding unavailable while a bot is disabled', async () => {
    renderAccess(false);
    const button = await screen.findByRole('button', { name: 'channels.bindAccount' });
    expect(button).toBeDisabled();
    expect(screen.getByText('channels.enableToBind')).toBeInTheDocument();
    fireEvent.click(button);
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it('retires an expired command and offers a fresh challenge', async () => {
    mocks.challenge.mockResolvedValueOnce({
      code: 'TESTCODE',
      command: '/bind TESTCODE',
      expiresAt: Date.now() + 400,
    });
    renderAccess();
    fireEvent.click(await screen.findByRole('button', { name: 'channels.bindAccount' }));
    expect(await screen.findByText('/bind TESTCODE')).toBeInTheDocument();
    expect(await screen.findByText('channels.codeExpired')).toBeInTheDocument();
    expect(screen.queryByText('/bind TESTCODE')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'channels.regenerate' }));
    await waitFor(() => expect(mocks.challenge).toHaveBeenCalledTimes(2));
  });

  it('sends permission changes to the current bot', async () => {
    renderAccess();
    fireEvent.click(await screen.findByRole('switch', { name: 'channels.requireBinding' }));
    await waitFor(() =>
      expect(mocks.permissions).toHaveBeenCalledWith({ providerId: 'first', requireBinding: true }),
    );
  });

  it('clears the previous challenge when navigating to a different bot', async () => {
    const view = renderAccess();
    fireEvent.click(await screen.findByRole('button', { name: 'channels.bindAccount' }));
    expect(await screen.findByText('/bind TESTCODE')).toBeInTheDocument();
    view.switchProvider('second');
    await waitFor(() => expect(screen.queryByText('/bind TESTCODE')).not.toBeInTheDocument());
    expect(mocks.list).toHaveBeenCalledWith({ providerId: 'second' });
  });
});
