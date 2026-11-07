import useSWR from 'swr';

import { channelService } from '@/services/channel';
import { useUserStore } from '@/store/user';

export const CHANNEL_LIST_KEY = 'channel-workspace:list';
export const useChannelProviders = () => {
  const userId = useUserStore((state) => state.user?.id);
  return useSWR(userId ? [CHANNEL_LIST_KEY, userId] : null, () => channelService.list(), {
    refreshInterval: 15_000,
  });
};
export type ChannelProvider = Awaited<ReturnType<typeof channelService.list>>[number];
