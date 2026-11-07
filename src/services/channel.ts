import { lambdaClient } from '@/libs/trpc/client';
import type { ChannelDetail, ChannelProviderSummary } from '@/types/channel';

class ChannelService {
  tasks = (providerId: string) => lambdaClient.channel.tasks.query({ providerId });
  task = (providerId: string, taskId: string) =>
    lambdaClient.channel.task.query({ providerId, taskId });
  list = async (): Promise<ChannelProviderSummary[]> => lambdaClient.channel.list.query();

  detail = async (providerId: string): Promise<ChannelDetail> =>
    lambdaClient.channel.detail.query({ providerId });
}

export const channelService = new ChannelService();
