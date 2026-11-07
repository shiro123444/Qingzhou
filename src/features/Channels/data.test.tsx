// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { describe, expect, it, vi } from 'vitest';

import { useChannelProviders } from './data';

const mocks = vi.hoisted(() => ({ list: vi.fn(), userId: 'first-user' }));
vi.mock('@/services/channel', () => ({ channelService: { list: mocks.list } }));
vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: mocks.userId } }),
}));

describe('channel workspace account isolation', () => {
  it('hides a previous account’s providers while another account is loading', async () => {
    const privateProvider = { id: 'first-user-private-bot' };
    mocks.list
      .mockResolvedValueOnce([privateProvider])
      .mockImplementationOnce(() => new Promise(() => {}));
    const cache = new Map();
    const wrapper = ({ children }: PropsWithChildren) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    const result = renderHook(() => useChannelProviders(), { wrapper });
    await waitFor(() => expect(result.result.current.data).toEqual([privateProvider]));
    mocks.userId = 'second-user';
    result.rerender();
    expect(result.result.current.data).toBeUndefined();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(result.result.current.data).toBeUndefined();
  });
});
