import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { act } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import chat from '@/locales/default/chat';
import { aiAgentService } from '@/services/aiAgent';
import { backgroundActivityService } from '@/services/backgroundActivity';
import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { useUserStore } from '@/store/user';
import type { ActivityHealth, ActivityItem, ActivityPage } from '@/types/backgroundActivity';

import { BackgroundActivityButton } from '.';

const health: ActivityHealth = {
  checkedAt: '2026-11-14T00:00:00.000000Z',
  queue: {
    ready: 0,
    scheduled: 0,
    running: 0,
    expiredLeases: 0,
    quarantined: 0,
    oldestReadyAgeSeconds: 0,
  },
  workers: ['agent', 'wake'].map((kind) => ({
    kind: kind as 'agent' | 'wake',
    status: 'unobserved',
    healthyInstances: 0,
    degradedInstances: 0,
    consecutiveFailures: 0,
  })),
};
beforeEach(() => {
  useUserStore.setState({ isSignedIn: true, user: { id: 'owner' } });
  vi.spyOn(backgroundActivityService, 'health').mockResolvedValue(health);
  vi.spyOn(backgroundActivityService, 'reviewHistory').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount(mode: 'native' | 'local' = 'native') {
  const store = initServerConfigStore({
    serverConfig: {
      agentRuntimeMode: mode === 'native' ? 'native' : undefined,
      aiProvider: {},
      telemetry: {},
    },
  });
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { chat } } });
  return render(
    <Provider createStore={() => store}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter>
            <BackgroundActivityButton />
          </MemoryRouter>
        </I18nextProvider>
      </SWRConfig>
    </Provider>,
  );
}
const item = (id: string, overrides: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  category: 'agent',
  kind: 'conversation',
  status: 'running',
  canStop: true,
  attempts: 1,
  createdAt: '2026-11-13T00:00:00.000000Z',
  updatedAt: '2026-11-13T00:00:00.000000Z',
  ...overrides,
});

it('does not fetch while closed or in a different runtime, and unmounts when closed', async () => {
  const list = vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({ items: [] });
  const local = await mount('local');
  expect(screen.queryByRole('button', { name: 'Background activity' })).toBeNull();
  expect(list).not.toHaveBeenCalled();
  expect(backgroundActivityService.health).not.toHaveBeenCalled();
  local.unmount();
  await mount();
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('No activity in this view');
  expect(list).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Background activity' })).toBeNull(),
  );
  const count = list.mock.calls.length;
  const healthCount = vi.mocked(backgroundActivityService.health).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 5100));
  expect(list).toHaveBeenCalledTimes(count);
  expect(backgroundActivityService.health).toHaveBeenCalledTimes(healthCount);
}, 10000);

it('links owned conversations and tasks, stops only live conversations, and refreshes saved status', async () => {
  const live = item('live', {
    title: 'Draft report',
    agentId: 'agent',
    topicId: 'topic',
    taskId: 'task',
  });
  const list = vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({
    items: [
      live,
      item('unknown', { title: 'Review result', status: 'unknown', canStop: false }),
      item('wake', { title: 'Morning wake', category: 'wake', kind: 'schedule', canStop: false }),
    ],
  });
  const stop = vi.spyOn(aiAgentService, 'interruptTask').mockImplementation(async () => {
    list.mockResolvedValue({ items: [{ ...live, status: 'cancelled', canStop: false }] });
    return { success: true, operationId: 'live' };
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('Draft report');
  expect(screen.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
    'href',
    '/agent/agent/topic',
  );
  expect(screen.getByRole('link', { name: 'View task' })).toHaveAttribute('href', '/task/task');
  expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
  expect(screen.getByText(/Execution may have taken effect/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByText('Stopped');
  expect(stop).toHaveBeenCalledExactlyOnceWith({ operationId: 'live' });
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

it('loads another cursor page and resets the list for a new filter', async () => {
  const cursor = {
    id: 'page1',
    category: 'agent' as const,
    createdAt: '2026-11-13T00:00:00.000000Z',
  };
  const list = vi
    .spyOn(backgroundActivityService, 'list')
    .mockImplementation(async (input = {}): Promise<ActivityPage> =>
      input.filter === 'attention'
        ? { items: [item('issue', { title: 'Needs a review', status: 'unknown', canStop: false })] }
        : input.cursor
          ? { items: [item('page2', { title: 'Second page' })] }
          : { items: [item('page1', { title: 'First page' })], nextCursor: cursor },
    );
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('First page');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Second page');
  expect(list).toHaveBeenCalledWith({ filter: 'all', cursor });
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Filter activity' })).getByRole('button', {
      name: 'Needs attention',
    }),
  );
  await screen.findByText('Needs a review');
  expect(screen.queryByText('First page')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('shows a recoverable query failure without rendering raw provider errors', async () => {
  const list = vi
    .spyOn(backgroundActivityService, 'list')
    .mockRejectedValue(new Error('private token'));
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('Could not load activity. Refresh to try again.');
  expect(screen.queryByText('private token')).toBeNull();
  list.mockResolvedValue({ items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('No activity in this view');
});

it('drops the previous account view and cache when the signed-in account changes', async () => {
  const list = vi
    .spyOn(backgroundActivityService, 'list')
    .mockResolvedValue({ items: [item('old', { title: 'Previous account activity' })] });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('Previous account activity');
  list.mockResolvedValue({ items: [] });
  act(() => useUserStore.setState({ user: { id: 'another-owner' } }));
  expect(screen.queryByText('Previous account activity')).toBeNull();
  await screen.findByText('No activity in this view');
  act(() => useUserStore.setState({ isSignedIn: false, user: undefined }));
  expect(screen.queryByRole('region', { name: 'Background activity' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Background activity' })).toBeNull();
});

it('does not announce a successful stop when the runtime refuses it', async () => {
  vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({
    items: [item('live', { title: 'Still running' })],
  });
  vi.spyOn(aiAgentService, 'interruptTask').mockResolvedValue({ success: false });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('Still running');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByText('Could not confirm the stop. Refresh to check its current status.');
  expect(screen.queryByText('Stopped')).toBeNull();
});

it('requires an explicit conclusion and evidence, then refreshes the recorded review', async () => {
  const unknown = item('unknown', {
    title: 'Uncertain action',
    status: 'unknown',
    canStop: false,
    incidentToken: 'a'.repeat(32),
  });
  const list = vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({ items: [unknown] });
  const evidence = 'Checked the destination and verified no document was created.';
  const save = vi.spyOn(backgroundActivityService, 'recordReview').mockImplementation(async () => {
    const review = {
      decision: 'no_effect' as const,
      evidence,
      reviewedAt: '2026-11-14T01:00:00.000000Z',
    };
    list.mockResolvedValue({ items: [{ ...unknown, review }] });
    return review;
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Record review' }));
  // rc-util uses the same title ID for every portal in test mode; scope by its action.
  const modal = (
    await screen.findByRole('button', { name: 'Save conclusion' })
  ).closest<HTMLElement>('[role="dialog"]')!;
  const submit = within(modal).getByRole('button', { name: 'Save conclusion' });
  expect(submit).toBeDisabled();
  fireEvent.click(within(modal).getByRole('radio', { name: 'No effect confirmed' }));
  expect(submit).toBeDisabled();
  fireEvent.change(within(modal).getByRole('textbox'), { target: { value: evidence } });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(save).toHaveBeenCalledExactlyOnceWith({
      category: 'agent',
      id: 'unknown',
      incidentToken: 'a'.repeat(32),
      decision: 'no_effect',
      evidence,
    }),
  );
  await screen.findByRole('button', { name: 'Review history' });
  expect(screen.getByText('Outcome unknown')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

it('retains evidence on a stale review error and does not claim it was saved', async () => {
  vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({
    items: [item('unknown', { status: 'unknown', canStop: false, incidentToken: 'a'.repeat(32) })],
  });
  vi.spyOn(backgroundActivityService, 'recordReview').mockRejectedValue(
    new Error('private provider failure'),
  );
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Record review' }));
  const modal = (
    await screen.findByRole('button', { name: 'Save conclusion' })
  ).closest<HTMLElement>('[role="dialog"]')!;
  fireEvent.click(within(modal).getByRole('radio', { name: 'End follow-up' }));
  fireEvent.change(within(modal).getByRole('textbox'), {
    target: { value: 'Checked external state and ended further follow-up.' },
  });
  fireEvent.click(within(modal).getByRole('button', { name: 'Save conclusion' }));
  await within(modal).findByText(
    'The activity changed or the review could not be saved. Refresh and review the latest record.',
  );
  expect(within(modal).getByRole('textbox')).toHaveValue(
    'Checked external state and ended further follow-up.',
  );
  expect(screen.queryByText('private provider failure')).toBeNull();
});

it('shows missing heartbeats honestly and hides cached healthy status when monitoring fails', async () => {
  vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({ items: [] });
  const monitored = vi.mocked(backgroundActivityService.health).mockResolvedValue({
    ...health,
    workers: [{ ...health.workers[0], status: 'online', healthyInstances: 1 }, health.workers[1]],
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  await screen.findByText('Online');
  expect(screen.getByText('No heartbeat recorded')).toBeVisible();
  monitored.mockRejectedValue(new Error('private database URL'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Could not read worker monitoring. Current availability is unknown.');
  expect(screen.queryByText('Online')).toBeNull();
  expect(screen.queryByText('private database URL')).toBeNull();
});

it('keeps earlier audit history readable after the execution changes without offering a new review', async () => {
  vi.spyOn(backgroundActivityService, 'list').mockResolvedValue({
    items: [
      item('complete', {
        title: 'Recovered execution',
        status: 'completed',
        canStop: false,
        hasReviewHistory: true,
      }),
    ],
  });
  vi.mocked(backgroundActivityService.reviewHistory).mockResolvedValue([
    {
      decision: 'closed',
      evidence: 'An earlier incident was checked and follow-up ended.',
      reviewedAt: '2026-11-14T01:00:00.000000Z',
    },
  ]);
  const record = vi.spyOn(backgroundActivityService, 'recordReview');
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Background activity' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review history' }));
  await screen.findByText(/An earlier incident was checked/);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save conclusion' })).toBeNull();
  expect(record).not.toHaveBeenCalled();
});
