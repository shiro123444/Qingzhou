// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDetail } from '@/types/channel';

import ChannelProviderPage from './Provider';

const mocks = vi.hoisted(() => ({ detail: vi.fn(), connect: vi.fn(), update: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'viewer' } }),
}));
vi.mock('@/services/channel', () => ({ channelService: { detail: mocks.detail } }));
vi.mock('@/services/agentBotProvider', () => ({
  agentBotProviderService: { connectBot: mocks.connect, update: mocks.update },
}));
vi.mock('../components/Access', () => ({ default: () => null }));

const detail = (enabled = true): ChannelDetail => ({
  activity: [],
  provider: {
    id: 'provider',
    agentId: 'agent',
    agentTitle: 'Test Agent',
    applicationId: 'app',
    platform: 'qq',
    connectionMode: 'websocket',
    enabled,
    updatedAt: new Date(),
    runtimeStatus: { platform: 'qq', applicationId: 'app', status: 'disconnected', updatedAt: 0 },
  },
  settings: {
    allowFrom: [],
    groupAllowFrom: [],
    dmPolicy: 'open',
    groupPolicy: 'open',
    channelIdentity: { requireBinding: false },
  },
});

function renderProvider() {
  return render(
    <MemoryRouter initialEntries={['/channels/qq/provider/overview']}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <App>
          <Routes>
            <Route
              element={<ChannelProviderPage />}
              path="/channels/:platform/:providerId/:section"
            />
          </Routes>
        </App>
      </SWRConfig>
    </MemoryRouter>,
  );
}

describe('channel connection controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail.mockResolvedValue(detail());
    mocks.connect.mockResolvedValue({ status: 'queued' });
    mocks.update.mockResolvedValue(undefined);
  });

  it('keeps a disabled bot from starting a connection', async () => {
    mocks.detail.mockResolvedValue(detail(false));
    renderProvider();
    const connect = await screen.findByRole('button', { name: 'channels.connect' });
    expect(connect).toBeDisabled();
    fireEvent.click(connect);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('persists the selected bot enable state', async () => {
    renderProvider();
    fireEvent.click(await screen.findByRole('switch', { name: 'channels.enabled' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('provider', { enabled: false }));
  });

  it('connects the selected application and surfaces queued ownership', async () => {
    renderProvider();
    fireEvent.click(await screen.findByRole('button', { name: 'channels.connect' }));
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith({ applicationId: 'app', platform: 'qq' }),
    );
    expect(await screen.findByText('channels.connectQueued')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'channels.configure' })).toHaveAttribute(
      'href',
      '/agent/agent/channel?platform=qq',
    );
  });
});
