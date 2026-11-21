import type { LobeChatDatabase } from '@/database/type';
import { NativeAgentStore } from '@/server/runtime/tasks/store';

import type { QueueServiceImpl } from './type';

/** Scheduling only; the separately mounted native worker owns execution. */
export class NativeQueueServiceImpl implements QueueServiceImpl {
  private readonly store: NativeAgentStore;
  constructor(
    db: LobeChatDatabase | (() => Promise<LobeChatDatabase>),
    private readonly userId: string,
  ) {
    if (!userId) throw new Error('NATIVE_QUEUE_OWNER_REQUIRED');
    this.store = new NativeAgentStore(db);
  }
  scheduleMessage: QueueServiceImpl['scheduleMessage'] = (message) =>
    this.store.enqueue(this.userId, message);
  async scheduleBatchMessages(messages: Parameters<QueueServiceImpl['scheduleBatchMessages']>[0]) {
    const ids = [];
    for (const message of messages) ids.push(await this.scheduleMessage(message));
    return ids;
  }
  cancelScheduledTask: QueueServiceImpl['cancelScheduledTask'] = (id) =>
    this.store.cancelJob(this.userId, id);
  getQueueStats: QueueServiceImpl['getQueueStats'] = () => this.store.stats(this.userId);
  async healthCheck() {
    try {
      await this.store.stats(this.userId);
      return { healthy: true };
    } catch {
      return {
        healthy: false,
        message: 'Native execution database unavailable or migrations missing',
      };
    }
  }
}
