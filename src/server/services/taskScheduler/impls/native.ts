import type { LobeChatDatabase } from '@/database/type';
import { enqueueNativeHeartbeat } from '@/server/runtime/tasks/wakeScheduling';
import { NativeWakeStore } from '@/server/runtime/tasks/wakeStore';

import type { TaskSchedulerImpl } from './type';

export class NativeTaskScheduler implements TaskSchedulerImpl {
  constructor(private readonly database: () => Promise<LobeChatDatabase>) {}
  scheduleNextTopic: TaskSchedulerImpl['scheduleNextTopic'] = async ({
    taskId,
    userId,
    delay,
    expectedVersion,
  }) => {
    if (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
      throw new Error('Invalid wake delay');
    return enqueueNativeHeartbeat(await this.database(), taskId, userId, delay, expectedVersion);
  };
  async cancelScheduled(id: string, userId?: string) {
    if (!userId) throw new Error('NATIVE_WAKE_OWNER_REQUIRED');
    await new NativeWakeStore(await this.database()).cancel(userId, id);
  }
}
