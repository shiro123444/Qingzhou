import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import { agentComputerService } from '@/services/agentComputer';
import { useUiAttentionStore } from '@/store/uiAttention';
import type { ComputerView } from '@/types/agentComputer';

import zhChat from '../../../locales/zh-CN/chat.json';
import Companion from './Companion';
import * as Avatar from './CompanionAvatar';

const ready: ComputerView = {
  enabled: true,
  commands: [],
  session: {
    id: 'session',
    state: 'ready',
    control: 'human',
    revision: 1,
    busy: false,
    updatedAt: '2026-11-16T00:00:00Z',
  },
};
beforeEach(() => {
  vi.spyOn(Avatar, 'default').mockImplementation(() => <span data-testid="partner-avatar" />);
  vi.spyOn(agentComputerService, 'get').mockResolvedValue(ready);
  vi.spyOn(agentComputerService, 'tasks').mockResolvedValue({
    total: 1,
    items: [
      {
        id: 'task',
        title: 'Daily brief',
        status: 'scheduled',
        mode: 'heartbeat',
        intervalSeconds: 1800,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUiAttentionStore.setState({
    ownerId: undefined,
    agentId: undefined,
    signal: undefined,
    enabled: true,
  });
});
async function mount() {
  const i18n = createInstance();
  await i18n
    .use(initReactI18next)
    .init({ lng: 'en', resources: { 'en': { chat }, 'zh-CN': { chat: zhChat } } });
  const view = render(
    <MemoryRouter>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <I18nextProvider i18n={i18n}>
          <Companion agentId="agent" name="Jumi" ownerId="owner" />
        </I18nextProvider>
      </SWRConfig>
    </MemoryRouter>,
  );
  return { ...view, i18n };
}
it('shows owned plans without a live screen and observes only after an explicit computer click', async () => {
  const observe = vi.spyOn(agentComputerService, 'observe').mockResolvedValue({
    revision: 1,
    frame: {
      running: true,
      image: 'AA==',
      width: 1100,
      height: 700,
      url: 'about:blank',
      title: 'Browser',
      text: '',
      controls: [],
    },
  });
  const manage = vi.spyOn(agentComputerService, 'manage');
  await mount();
  const plan = await screen.findByRole('link', { name: 'Daily brief Every 30 min' });
  expect(plan).toHaveAttribute('href', '/task/task');
  expect(agentComputerService.tasks).toHaveBeenCalledWith('agent');
  expect(document.querySelector('[data-computer-companion] img')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pull to open the computer' })).toBeNull();
  expect(observe).not.toHaveBeenCalled();
  await screen.findByTestId('partner-avatar');
  expect(vi.mocked(Avatar.default).mock.calls.at(-1)?.[0].state).toBe('human');
  fireEvent.click(screen.getByRole('button', { name: 'View & control' }));
  await screen.findByRole('application', { name: 'Live browser screen' });
  expect(observe).toHaveBeenCalledWith('agent', 1);
  expect(manage).not.toHaveBeenCalled();
});
it('separates real approvals and keeps the pointer switch and navigation localized', async () => {
  vi.mocked(agentComputerService.get).mockResolvedValue({
    ...ready,
    activity: { phase: 'approval', topicId: 'topic' },
  });
  const { i18n } = await mount();
  await screen.findByText('An action needs your decision');
  fireEvent.click(screen.getByRole('tab', { name: 'Review 1' }));
  expect(
    screen.getByRole('link', { name: 'An action needs your decision Review the requested action' }),
  ).toHaveAttribute('href', '/agent/agent/topic');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Review 1' }), { key: 'ArrowRight' });
  const off = await screen.findByRole('button', { name: 'Turn off companion awareness' });
  fireEvent.click(off);
  await waitFor(() => expect(useUiAttentionStore.getState().enabled).toBe(false));
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  expect(screen.getByRole('tab', { name: '感知' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('button', { name: '开启伙伴互动感知' })).toBeVisible();
});

it('keeps focus on the folded partner and restores the selected tab without opening the computer', async () => {
  const observe = vi.spyOn(agentComputerService, 'observe');
  await mount();
  await screen.findByTestId('partner-avatar');
  fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
  const toggle = document.querySelector<HTMLElement>(
    '[data-computer-companion] [aria-controls][aria-expanded]',
  )!;
  const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  toggle.focus();
  fireEvent.keyDown(toggle, { key: 'Enter' });
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(content).toHaveAttribute('inert');
  fireEvent.keyDown(toggle, { key: ' ' });
  expect(toggle).toHaveFocus();
  expect(content).not.toHaveAttribute('inert');
  expect(screen.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  expect(observe).not.toHaveBeenCalled();
});
