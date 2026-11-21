import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';
import { isNativeAgentRuntimeEnabled } from '@/server/runtime/tasks/mode';

import { LocalQueueServiceImpl } from './local';
import { NativeQueueServiceImpl } from './native';
import { QStashQueueServiceImpl } from './qstash';
import { type QueueServiceImpl } from './type';

/**
 * Check if queue-based agent runtime is enabled
 * Cross-process execution uses serialized hooks in both queue and native modes.
 */
export const isQueueAgentRuntimeEnabled = (): boolean => {
  return appEnv.enableQueueAgentRuntime === true || isNativeAgentRuntimeEnabled();
};

/**
 * Create queue service module
 * Native mode schedules account-scoped PostgreSQL jobs and requires a separate worker host.
 *
 * When enableQueueAgentRuntime=true (AGENT_RUNTIME_MODE=queue):
 *   - QStashQueueServiceImpl (production, requires QSTASH_TOKEN)
 *
 * When enableQueueAgentRuntime=false (default):
 *   - LocalQueueServiceImpl (local development, uses setTimeout for async execution)
 */
export const createQueueServiceModule = (options?: {
  db?: LobeChatDatabase;
  userId?: string;
}): QueueServiceImpl => {
  if (isNativeAgentRuntimeEnabled())
    return new NativeQueueServiceImpl(
      options?.db ?? (async () => (await import('@/database/server')).getServerDB()),
      options?.userId ?? '',
    );
  if (isQueueAgentRuntimeEnabled()) {
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!qstashToken) {
      throw new Error('QSTASH_TOKEN is required when AGENT_RUNTIME_MODE=queue');
    }
    return new QStashQueueServiceImpl({ qstashToken });
  }

  // Local mode (default): use LocalQueueServiceImpl with callback mechanism
  return new LocalQueueServiceImpl();
};

export { LocalQueueServiceImpl } from './local';
export type { QueueServiceImpl } from './type';
