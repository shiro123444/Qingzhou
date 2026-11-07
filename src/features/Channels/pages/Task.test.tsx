// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi } from 'vitest';

import ChannelTaskPage from './Task';

const task = vi.hoisted(() => vi.fn());
vi.mock('@/services/channel', () => ({ channelService: { task } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/store/user', () => ({
  useUserStore: (select: any) => select({ user: { id: 'owner' } }),
}));

describe('channel task details', () => {
  it('shows a retained result inside the provider hierarchy with an authenticated conversation link', async () => {
    task.mockResolvedValue({
      id: 'task',
      operationId: 'op',
      completed: true,
      content: 'Full retained result',
      artifactIds: ['file'],
      delivery: 'retained',
      reason: 'reply_window_expired',
      topicId: 'topic',
      updatedAt: new Date(),
      provider: {
        agentId: 'agent',
        agentTitle: 'Assistant',
        applicationId: 'app',
        platform: 'wechat',
      },
    });
    render(
      <MemoryRouter initialEntries={['/channels/wechat/provider/activity/tasks/task']}>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <App>
            <Routes>
              <Route
                path="/channels/:platform/:providerId/activity/tasks/:taskId"
                element={<ChannelTaskPage />}
              />
            </Routes>
          </App>
        </SWRConfig>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Full retained result')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'channels.sections.activity' })).toHaveAttribute(
      'href',
      '/channels/wechat/provider/activity',
    );
    expect(screen.getByRole('link', { name: 'channels.tasks.conversation' })).toHaveAttribute(
      'href',
      '/agent/agent?topic=topic',
    );
    expect(screen.getByRole('button', { name: 'channels.tasks.copyCommand' })).toBeEnabled();
    expect(screen.getByText('channels.tasks.status.retained')).toBeInTheDocument();
  });
});
