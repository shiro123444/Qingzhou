import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { SWRConfig } from 'swr';
import { afterEach, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import { agentComputerService } from '@/services/agentComputer';
import type { ComputerView } from '@/types/agentComputer';

import zhChat from '../../../locales/zh-CN/chat.json';
import Panel from './Panel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const ready: ComputerView = {
  enabled: true,
  session: {
    id: 'session',
    state: 'ready',
    control: 'agent',
    revision: 1,
    busy: false,
    updatedAt: '2026-11-15T00:00:00Z',
  },
  commands: [],
};
async function mount(language = 'en') {
  const i18n = createInstance();
  await i18n
    .use(initReactI18next)
    .init({ lng: language, resources: { 'en': { chat }, 'zh-CN': { chat: zhChat } } });
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <I18nextProvider i18n={i18n}>
        <Panel agentId={'agent'} ownerId={'owner'} onClose={() => undefined} />
      </I18nextProvider>
    </SWRConfig>,
  );
  return { ...view, i18n };
}

it('inspects a disabled or unallocated computer without creating resources', async () => {
  const get = vi
    .spyOn(agentComputerService, 'get')
    .mockResolvedValue({ enabled: false, commands: [] });
  const manage = vi.spyOn(agentComputerService, 'manage');
  const view = await mount();
  await screen.findByText('Computer capability is not enabled.');
  expect(manage).not.toHaveBeenCalled();
  view.unmount();
  get.mockResolvedValue({ enabled: true, commands: [] });
  await mount();
  await screen.findByText('Your computer is not open yet');
  expect(manage).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open computer' })).toBeEnabled();
});

it('opens only after a click and version-checks preparation, control and browser start', async () => {
  const get = vi
    .spyOn(agentComputerService, 'get')
    .mockResolvedValue({ enabled: true, commands: [] });
  const manage = vi.spyOn(agentComputerService, 'manage').mockImplementation(async (input) => {
    const next: ComputerView =
      input.command.kind === 'ensure'
        ? ready
        : {
            ...ready,
            session: {
              ...ready.session!,
              control: input.command.kind === 'control' ? input.command.target : 'human',
              revision: input.command.kind === 'browser' ? 3 : 2,
            },
          };
    get.mockResolvedValue(next);
    return next;
  });
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Open computer' }));
  await screen.findByRole('button', { name: 'Return to assistant' });
  await screen.findByRole('heading', { name: 'You’re in control.' });
  expect(manage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      command: { kind: 'ensure' },
      expectedRevision: 0,
      requestId: expect.any(String),
    }),
  );
  expect(manage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ command: { kind: 'control', target: 'human' }, expectedRevision: 1 }),
  );
  expect(manage).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      command: { kind: 'browser', input: { action: 'start' } },
      expectedRevision: 2,
    }),
  );
});

it('stops an incomplete opening sequence rather than assuming human control', async () => {
  vi.spyOn(agentComputerService, 'get').mockResolvedValue({ enabled: true, commands: [] });
  const manage = vi
    .spyOn(agentComputerService, 'manage')
    .mockResolvedValue({ ...ready, actionFailed: true });
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Open computer' }));
  await screen.findByText(
    'The operation could not be confirmed. Refresh and check the saved receipt before trying again.',
  );
  expect(manage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Return to assistant' })).toBeNull();
});

it('keeps the initial screen minimal and follows live i18n language changes', async () => {
  vi.spyOn(agentComputerService, 'get').mockResolvedValue({
    enabled: true,
    commands: [],
    reasoningModel: { model: 'deepseek-v4.1-flash', provider: 'nexus' },
  });
  const { i18n } = await mount();
  await screen.findByRole('button', { name: 'Open computer' });
  const workbench = document.querySelector('[data-computer-workbench]') as HTMLElement;
  expect(within(workbench).getAllByRole('button')).toHaveLength(1);
  expect(
    screen.queryByText(/Work together|YOUR AGENT COMPUTER|Computer reasoning model:/),
  ).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => {
    await i18n.changeLanguage('zh-CN');
  });
  await screen.findByRole('button', { name: '打开电脑' });
  expect(screen.getByRole('heading', { name: '你的电脑' })).toBeInTheDocument();
  expect(screen.getByText('电脑还未打开')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open computer' })).toBeNull();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
  await screen.findByRole('button', { name: 'Open computer' });
});

it('blocks new input on busy, changed-provider and unknown sessions', async () => {
  const get = vi
    .spyOn(agentComputerService, 'get')
    .mockResolvedValue({ ...ready, session: { ...ready.session!, busy: true } });
  const manage = vi.spyOn(agentComputerService, 'manage');
  let view = await mount();
  await screen.findByText('Finishing the current action…');
  expect(screen.getByRole('button', { name: 'Take control' })).toBeDisabled();
  view.unmount();
  get.mockResolvedValue({ ...ready, bindingChanged: true });
  view = await mount();
  await screen.findByText(/computer service configuration changed/);
  expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
  view.unmount();
  get.mockResolvedValue({ ...ready, session: { ...ready.session!, state: 'unknown' } });
  await mount();
  await screen.findByRole('heading', { name: 'Let’s check this.' });
  expect(screen.queryByRole('button', { name: 'Sleep' })).toBeNull();
  expect(manage).not.toHaveBeenCalled();
});

it('keeps server control on an unconfirmed handoff and hides stale status after read failure', async () => {
  const get = vi.spyOn(agentComputerService, 'get').mockResolvedValue(ready);
  vi.spyOn(agentComputerService, 'manage').mockRejectedValue(new Error('private endpoint token'));
  await mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Take control' }));
  await screen.findByText(
    'The operation could not be confirmed. Refresh and check the saved receipt before trying again.',
  );
  expect(screen.queryByRole('button', { name: 'Return to assistant' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'You’re in control.' })).toBeNull();
  await screen.findByRole('heading', { name: 'Your companion’s ready.' });
  get.mockRejectedValue(new Error('private connection string'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Refresh computer' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh computer' }));
  await screen.findByText('Could not read the computer session.');
  expect(screen.queryByText('View only')).toBeNull();
  expect(screen.queryByText(/private endpoint token|private connection string/)).toBeNull();
});

it('checks a saved receipt without issuing a new management command', async () => {
  const unknown: ComputerView = {
    ...ready,
    reasoningModel: { model: 'deepseek-v4.1-flash', provider: 'nexus' },
    session: { ...ready.session!, state: 'unknown' },
    commands: [
      {
        id: 'command',
        actor: 'agent',
        kind: 'shell',
        status: 'unknown',
        createdAt: '2026-11-15T00:00:00Z',
      },
    ],
  };
  const get = vi.spyOn(agentComputerService, 'get').mockResolvedValue(unknown);
  const manage = vi.spyOn(agentComputerService, 'manage');
  const lookup = vi.spyOn(agentComputerService, 'reconcile').mockImplementation(async () => {
    get.mockResolvedValue(ready);
    return { ...ready, receiptStatus: 'done' };
  });
  await mount();
  await screen.findByText('Computer reasoning model: deepseek-v4.1-flash');
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved receipt' }));
  await screen.findByRole('heading', { name: 'Your companion’s ready.' });
  expect(lookup).toHaveBeenCalledExactlyOnceWith('agent', 'command');
  expect(manage).not.toHaveBeenCalled();
});

it('preserves typed text when the computer rejects an input command', async () => {
  vi.spyOn(agentComputerService, 'get').mockResolvedValue({
    ...ready,
    session: { ...ready.session!, control: 'human' },
  });
  vi.spyOn(agentComputerService, 'observe').mockResolvedValue({
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
  vi.spyOn(agentComputerService, 'manage').mockResolvedValue({ ...ready, actionFailed: true });
  await mount();
  const input = await screen.findByRole('textbox', {
    name: 'Text to enter in the focused browser field',
  });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enter text' }));
  await screen.findByText(
    'The browser request is stale or unavailable. Refresh the session before continuing.',
  );
  expect(input).toHaveValue('Keep this draft');
});
