import '@testing-library/jest-dom/vitest';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
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
        context: ['已保留 12 页草稿', '当前页使用原始图表'],
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

function setupStore(selectedJob: PresentationJob = job) {
  i18n.addResourceBundle('en-US', 'common', common, true, true);
  i18n.addResourceBundle('en', 'common', common, true, true);
  i18n.addResourceBundle('zh-CN', 'common', common, true, true);
  const client = new RuntimeClientImpl({ fetcher: vi.fn() });
  const presence = vi.spyOn(client, 'updatePresentationPresence').mockResolvedValue();
  vi.spyOn(client, 'getPresentationJob').mockResolvedValue(selectedJob);
  const store = createPresentationStudioStore(client);
  store.setState({
    jobs: { [selectedJob.jobId]: structuredClone(selectedJob) },
    selectedJobId: selectedJob.jobId,
  });
  return { client, store, presence };
}

function renderCollaboration(
  selectedJob: PresentationJob,
  store: ReturnType<typeof setupStore>['store'],
) {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <I18nextProvider i18n={i18n}>
        <CollaborationPanel job={selectedJob} store={store} tabId="tab-1" />
      </I18nextProvider>
    </ConfigProvider>,
  );
}

async function openDecision() {
  fireEvent.click(await screen.findByTestId('presentation-collaboration-question-trigger'));
  await waitFor(() => expect(screen.getByTestId('presentation-decision-card')).toBeVisible());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('presentation collaboration UI', () => {
  it('preserves collaboration questions in streamed job projections', () => {
    expect(projectJobSnapshot(job)?.collaboration).toEqual(job.collaboration);
  });

  it('keeps decisions out of the main view until requested and submits an explicit answer', async () => {
    const { client, store } = setupStore();
    const answer = vi
      .spyOn(client, 'answerPresentationDecision')
      .mockResolvedValue({ ...job, state: 'queued' });
    renderCollaboration(job, store);

    await screen.findByTestId('presentation-collaboration-question-trigger');
    expect(screen.queryByTestId('presentation-decision-card')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await openDecision();
    expect(screen.getByText('草稿与资料已保存。')).toBeVisible();
    fireEvent.click(screen.getByText(/Relevant context|相关情况/));
    expect(screen.getByText('已保留 12 页草稿')).toBeVisible();
    expect(screen.getByRole('button', { name: /Confirm and continue|确认并继续/ })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '统一表格样式并保留原图' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm and continue|确认并继续/ }));

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

  it('selects a suggested answer without submitting it and never offers auto-repair for missing input', async () => {
    const inputJob = structuredClone(job);
    const decision = inputJob.collaboration!.decisions[0];
    decision.category = 'input';
    decision.choices = [
      { id: 'course', label: '课程/教学讲解', description: '面向学生' },
      { id: 'report', label: '项目或工作汇报' },
    ];
    decision.options = [
      { id: 'revise', label: '提交后继续', description: '提交你的回答' },
      { id: 'defer', label: '稍后决定', description: '保存进度' },
    ];
    const { client, store } = setupStore(inputJob);
    const answer = vi
      .spyOn(client, 'answerPresentationDecision')
      .mockResolvedValue({ ...inputJob, state: 'queued' });
    renderCollaboration(inputJob, store);

    await openDecision();
    const choice = screen.getByRole('button', { name: /课程\/教学讲解/ });
    expect(choice).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(choice);
    expect(choice).toHaveAttribute('aria-pressed', 'true');
    expect(answer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '继续修复' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and continue|确认并继续/ }));

    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(answer.mock.calls[0][1]).toEqual(
      expect.objectContaining({ action: 'revise', content: '课程/教学讲解' }),
    );
  });

  it('uses real thumbnails for visual choices and reveals the text field only on demand', async () => {
    const visualJob = structuredClone(job);
    const decision = visualJob.collaboration!.decisions[0];
    decision.category = 'input';
    decision.choices = [
      { id: 'narrative-keynote', label: '叙事型', description: '编辑叙事' },
      { id: 'custom', label: '自定义' },
    ];
    const { store } = setupStore(visualJob);
    renderCollaboration(visualJob, store);

    await openDecision();
    const choice = screen.getByRole('button', { name: '叙事型' });
    expect(choice.querySelector('img')).toHaveAttribute(
      'src',
      '/images/presentation-styles/narrative-keynote-cover.svg',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add details|补充说明/ }));
    expect(screen.getByRole('textbox')).toBeVisible();
  });

  it('does not open deferred questions automatically, but keeps the entry available', async () => {
    const { store } = setupStore();
    const deferred = structuredClone(job);
    deferred.collaboration!.decisions[0].status = 'deferred';
    renderCollaboration(deferred, store);

    expect(screen.queryByTestId('presentation-decision-card')).not.toBeInTheDocument();
    await openDecision();
    expect(screen.getByText('草稿与资料已保存。')).toBeVisible();
  });

  it('keeps an answer request id after transport failure so retry cannot execute it twice', async () => {
    const { client, store } = setupStore();
    const answer = vi
      .spyOn(client, 'answerPresentationDecision')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ...job, state: 'queued' });
    renderCollaboration(job, store);

    await openDecision();
    fireEvent.click(screen.getByRole('button', { name: '继续修复' }));
    await waitFor(() => expect(store.getState().clientError).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '继续修复' })).toHaveAttribute(
        'aria-busy',
        'false',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '继续修复' }));
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    expect(answer.mock.calls[0][1].requestId).toBe(answer.mock.calls[1][1].requestId);
  });

  it('uses a compact settings popover without persistent smart-mode text or a drawer', async () => {
    const completed = structuredClone(job);
    completed.state = 'completed';
    completed.collaboration!.decisions[0].status = 'answered';
    const { store } = setupStore(completed);
    renderCollaboration(completed, store);

    expect(screen.queryByText(/Smart handling|智能处理/)).not.toBeInTheDocument();
    const trigger = await screen.findByRole('button', {
      name: /Open collaboration settings|打开协作设置/,
    });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', {
      name: /Collaboration settings|协作设置/,
    });
    expect(dialog).toBeInTheDocument();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
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
