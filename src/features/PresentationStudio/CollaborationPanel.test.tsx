import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src';
import common from '../../locales/default/common';
import { RuntimeClientImpl } from '../../services/runtime/client';
import CollaborationPanel from './CollaborationPanel';
import { usePresentationPresence } from './hooks/usePresentationPresence';
import { createPresentationStudioStore, projectJobSnapshot } from './store/presentationStore';

const job: PresentationJob = {
  jobId: 'job-1',
  state: 'waiting_input',
  createdAt: '2026-10-15',
  updatedAt: '2026-10-15',
  collaboration: {
    mode: 'adaptive',
    automaticAttempts: 0,
    decisions: [
      {
        id: 'q1',
        category: 'quality',
        createdAt: '2026-10-15',
        title: '保留原图还是调整排版？',
        detail: '草稿与资料已保存。',
        status: 'pending',
        options: [
          { id: 'retry', label: '继续修复', description: '保留内容' },
          { id: 'revise', label: '按补充继续', description: '补充偏好' },
          { id: 'defer', label: '稍后决定', description: '保存进度' },
        ],
      },
    ],
  },
};
function setupStore() {
  i18n.addResourceBundle('en-US', 'common', common, true, true);
  i18n.addResourceBundle('en', 'common', common, true, true);
  i18n.addResourceBundle('zh-CN', 'common', common, true, true);
  const client = new RuntimeClientImpl({ fetcher: vi.fn() });
  const presence = vi.spyOn(client, 'updatePresentationPresence').mockResolvedValue();
  vi.spyOn(client, 'getPresentationJob').mockResolvedValue(job);
  const store = createPresentationStudioStore(client);
  store.setState({ jobs: { 'job-1': structuredClone(job) }, selectedJobId: 'job-1' });
  return { client, store, presence };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('presentation collaboration UI', () => {
  it('preserves collaboration questions in streamed job projections', () => {
    expect(projectJobSnapshot(job)?.collaboration).toEqual(job.collaboration);
  });
  it('shows the current question, requires text for a revision, and submits that answer', async () => {
    const { client, store } = setupStore();
    const answer = vi
      .spyOn(client, 'answerPresentationDecision')
      .mockResolvedValue({ ...job, state: 'queued' });
    render(
      <I18nextProvider i18n={i18n}>
        <CollaborationPanel job={job} store={store} tabId="tab-1" />
      </I18nextProvider>,
    );
    expect(await screen.findByText('保留原图还是调整排版？')).toBeVisible();
    expect(screen.getByRole('button', { name: '按补充继续' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '统一表格样式并保留原图' } });
    fireEvent.click(screen.getByRole('button', { name: '按补充继续' }));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(answer.mock.calls[0]).toEqual([
      'job-1',
      expect.objectContaining({
        decisionId: 'q1',
        action: 'revise',
        content: '统一表格样式并保留原图',
      }),
    ]);
    expect(store.getState().jobs['job-1'].state).toBe('queued');
  });
  it('does not open deferred questions automatically, but keeps the entry available', () => {
    const { store } = setupStore();
    const deferred = structuredClone(job);
    deferred.collaboration!.decisions[0].status = 'deferred';
    render(
      <I18nextProvider i18n={i18n}>
        <CollaborationPanel job={deferred} store={store} tabId="tab-1" />
      </I18nextProvider>,
    );
    expect(screen.queryByText('保留原图还是调整排版？')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /decision needed/ }));
    expect(screen.getByText('保留原图还是调整排版？')).toBeVisible();
  });
  it('keeps an answer request id after transport failure so retry cannot execute it twice', async () => {
    const { client, store } = setupStore();
    const answer = vi
      .spyOn(client, 'answerPresentationDecision')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...job, state: 'queued' });
    render(
      <I18nextProvider i18n={i18n}>
        <CollaborationPanel job={job} store={store} tabId="tab-1" />
      </I18nextProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '继续修复' }));
    await waitFor(() => expect(store.getState().clientError).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '继续修复' })).toHaveAttribute(
        'aria-busy',
        'false',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: '继续修复' }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    expect(answer.mock.calls[0][1].requestId).toBe(answer.mock.calls[1][1].requestId);
  });
  it('sends visibility and focus changes, switches the selected work, and clears its timer', async () => {
    vi.useFakeTimers();
    const { store, presence } = setupStore();
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { rerender, unmount } = renderHook(({ id }) => usePresentationPresence(store, id), {
      initialProps: { id: 'job-1' },
    });
    await act(async () => {});
    expect(presence).toHaveBeenLastCalledWith(
      'job-1',
      expect.objectContaining({ visible: true, focused: true }),
    );
    focused.mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(presence).toHaveBeenLastCalledWith('job-1', expect.objectContaining({ focused: false }));
    rerender({ id: 'job-2' });
    await act(async () => {});
    expect(presence.mock.calls).toContainEqual([
      'job-1',
      expect.objectContaining({ visible: false, focused: false }),
    ]);
    expect(presence).toHaveBeenLastCalledWith('job-2', expect.anything());
    unmount();
    await act(async () => {});
    const count = presence.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(presence).toHaveBeenCalledTimes(count);
    expect(presence).toHaveBeenLastCalledWith(
      'job-2',
      expect.objectContaining({ visible: false, focused: false }),
    );
  });
  it('uses the scoped HTTP endpoints without accepting a user scope from the browser', async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(job), { status: 200 }),
    );
    const client = new RuntimeClientImpl({ fetcher: fetcher as typeof fetch });
    await client.updatePresentationPresence('job/1', {
      tabId: 'tab',
      visible: false,
      focused: false,
    });
    await client.answerPresentationDecision('job/1', {
      decisionId: 'q',
      requestId: 'r',
      action: 'defer',
    });
    expect(fetcher.mock.calls[0][0]).toBe('/api/runtime/presentation/jobs/job%2F1/presence');
    expect(fetcher.mock.calls[1][0]).toBe('/api/runtime/presentation/jobs/job%2F1/decisions');
  });
});
