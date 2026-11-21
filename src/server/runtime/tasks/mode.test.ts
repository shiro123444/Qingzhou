// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import {
  createAgentStateManager,
  createStreamEventManager,
} from '@/server/modules/AgentRuntime/factory';
import { PostgresAgentStateManager } from '@/server/modules/AgentRuntime/PostgresAgentStateManager';
import * as redis from '@/server/modules/AgentRuntime/redis';
import {
  createQueueServiceModule,
  isQueueAgentRuntimeEnabled,
} from '@/server/services/queue/impls';
import { NativeQueueServiceImpl } from '@/server/services/queue/impls/native';

import { isNativeAgentRuntimeEnabled } from './mode';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('selects database state and durable scheduling without requiring a QStash token', () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  vi.stubEnv('QSTASH_TOKEN', undefined);
  const db = {} as LobeChatDatabase;
  expect(createAgentStateManager(db)).toBeInstanceOf(PostgresAgentStateManager);
  expect(createQueueServiceModule({ db, userId: 'owner' })).toBeInstanceOf(NativeQueueServiceImpl);
  expect(isQueueAgentRuntimeEnabled()).toBe(true);
  expect(() => createQueueServiceModule({ db })).toThrow('OWNER_REQUIRED');
});

it('rejects volatile cross-process streams and misspelled execution modes', () => {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  vi.spyOn(redis, 'getAgentRuntimeRedisClient').mockReturnValue(null);
  expect(() => createStreamEventManager()).toThrow('Redis is required');
  vi.stubEnv('AGENT_RUNTIME_MODE', 'natvie');
  expect(() => isNativeAgentRuntimeEnabled()).toThrow('AGENT_RUNTIME_MODE');
});
