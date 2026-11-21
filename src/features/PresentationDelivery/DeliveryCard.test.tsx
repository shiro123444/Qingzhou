import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeClient } from '@/services/runtime/client';
import { useUserStore } from '@/store/user';

import type { PresentationJob } from '../../../packages/runtime-contracts/src/index';
import DeliveryCard from './DeliveryCard';

const origin = { agentId: 'agent', messageId: 'message', topicId: 'topic' };
const published: PresentationJob = {
  jobId: 'work',
  title: '雨洪调度',
  state: 'completed',
  createdAt: '',
  updatedAt: '',
  versionId: 'v2',
  chatOrigin: origin,
  delivery: { coverId: 'v2:cover', pptxId: 'v2:deck', versionId: 'v2' },
};
const show = (jobId?: string) => {
  const router = createMemoryRouter(
    [
      {
        path: '/agent/agent/topic',
        element: (
          <SWRConfig value={{ provider: () => new Map() }}>
            <DeliveryCard jobId={jobId} origin={origin} />
          </SWRConfig>
        ),
      },
      { path: '/presentation', element: null },
    ],
    { initialEntries: ['/agent/agent/topic'] },
  );
  render(<RouterProvider router={router} />);
  return router;
};

describe('main chat presentation delivery', () => {
  const original = useUserStore.getState().user;
  beforeEach(() =>
    useUserStore.setState({ user: { ...original, id: 'owner' } as NonNullable<typeof original> }),
  );
  afterEach(() => {
    useUserStore.setState({ user: original });
    vi.restoreAllMocks();
  });

  it('recovers the originating message after an interrupted handoff and downloads its published version', async () => {
    const list = vi.spyOn(runtimeClient, 'listPresentationJobs').mockResolvedValue([published]);
    vi.spyOn(runtimeClient, 'getPresentationJob').mockResolvedValue(published);
    show();
    expect(await screen.findByAltText('presentationDelivery.cover')).toHaveAttribute(
      'src',
      '/api/runtime/presentation/artifacts/v2%3Acover?raw=true',
    );
    expect(list).toHaveBeenCalledWith(origin);
    expect(document.querySelector('a[download]')).toHaveAttribute(
      'href',
      '/api/runtime/presentation/artifacts/v2%3Adeck/download',
    );
  });

  it.each(['cover', 'title', 'keyboard'])(
    'opens the same canvas from the %s without reloading',
    async (action) => {
      vi.spyOn(runtimeClient, 'getPresentationJob').mockResolvedValue(published);
      const router = show(published.jobId);
      const user = userEvent.setup();
      const cover = await screen.findByAltText('presentationDelivery.cover');
      const title = screen.getByText('雨洪调度');
      const link = screen.getByRole('link', { name: 'presentationDelivery.open 雨洪调度' });
      expect(link).toContainElement(cover);
      expect(link).toContainElement(title);
      expect(screen.getAllByRole('link')).toHaveLength(2);
      if (action === 'keyboard') {
        await user.tab();
        expect(link).toHaveFocus();
        await user.tab();
        expect(screen.getByRole('link', { name: 'presentationDelivery.download' })).toHaveFocus();
        await user.tab({ shift: true });
        await user.keyboard('{Enter}');
      } else {
        await user.click(action === 'cover' ? cover : title);
      }
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/presentation?jobId=work',
      );
    },
  );

  it('keeps a bound card out of the tab order until it resolves to its own job', async () => {
    let resolve!: (job: PresentationJob) => void;
    const pending = new Promise<PresentationJob>((done) => {
      resolve = done;
    });
    vi.spyOn(runtimeClient, 'getPresentationJob').mockReturnValue(pending);
    show(published.jobId);
    expect(screen.queryByRole('link')).toBeNull();
    resolve(published);
    expect(
      await screen.findByRole('link', { name: 'presentationDelivery.open 雨洪调度' }),
    ).toHaveAttribute('href', '/presentation?jobId=work');
  });

  it.each([
    { ...published, chatOrigin: { ...origin, messageId: 'another' } },
    { ...published, versionId: 'v3' },
    { ...published, state: 'running' as const },
  ])(
    'withholds delivery when the receipt is for another message, version, or a running edit',
    async (job) => {
      const list = vi.spyOn(runtimeClient, 'listPresentationJobs');
      const get = vi.spyOn(runtimeClient, 'getPresentationJob').mockResolvedValue(job);
      show(job.jobId);
      await waitFor(() => expect(get).toHaveBeenCalledWith(job.jobId));
      await waitFor(() =>
        expect(screen.getByRole('status')).not.toHaveTextContent('presentationDelivery.loading'),
      );
      expect(list).not.toHaveBeenCalled();
      expect(screen.queryByAltText('presentationDelivery.cover')).toBeNull();
      expect(document.querySelector('a[download]')).toBeNull();
    },
  );
});
