// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import * as executor from '@/server/services/agentSignal/services/selfIteration/execute';
import { ReviewRunStatus } from '@/server/services/agentSignal/services/selfIteration/types';

import { executeBudgetedSignal } from './signal-budget';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('propagates a failed runtime result instead of allowing callers to project a completed review', async () => {
  vi.stubEnv('QINGZHOU_HARNESS_LEARNING_ENABLED', '0');
  vi.spyOn(executor, 'executeSelfIteration').mockResolvedValue({
    actions: [],
    content: 'truncated',
    ideas: [],
    intents: [],
    status: ReviewRunStatus.Failed,
    stepCount: 1,
    toolCalls: [],
    usage: [],
    writeOutcomes: [],
  });
  await expect(
    executeBudgetedSignal({} as LobeChatDatabase, {} as executor.ExecuteSelfIterationInput),
  ).rejects.toThrow('AGENT_SIGNAL_SELF_ITERATION_FAILED');
});
