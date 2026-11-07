import type { LobeChatDatabase } from '@lobechat/database';

import {
  executeSelfIteration,
  type ExecuteSelfIterationInput,
} from '@/server/services/agentSignal/services/selfIteration/execute';

import {
  captureLearningCommand,
  openLearningBudget,
  withHarnessCoordinator,
  withLearningBudget,
} from './production';

/** Existing AgentSignal scheduling remains the owner; this adds no new experiment or retry. */
export async function executeBudgetedSignal(
  db: LobeChatDatabase,
  input: ExecuteSelfIterationInput,
) {
  if (process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1') return executeSelfIteration(input);
  const scope = {
    userId: input.userId,
    subject: { kind: 'agent' as const, agentId: input.agentId },
  };
  const perCall = { calls: 1, tokens: 132608, costMicros: 50000 };
  const calls = Math.max(1, input.maxSteps) + 4;
  const limit = { calls, tokens: calls * perCall.tokens, costMicros: calls * perCall.costMicros };
  const binding =
    input.learningBudget ??
    (await withLearningBudget(
      db,
      async (port) =>
        (
          await openLearningBudget(port, scope, `signal:${input.sourceId}`, limit, {
            reflection: limit,
          })
        ).reflection,
    ));
  if (
    binding.ref.scope.userId !== scope.userId ||
    binding.ref.scope.subject.kind !== 'agent' ||
    binding.ref.scope.subject.agentId !== input.agentId
  )
    throw new Error('LEARNING_BUDGET_SCOPE');
  const record = async (result?: Awaited<ReturnType<typeof executeSelfIteration>>) => {
    const state = await binding.port.read(scope, binding.ref.rootId);
    const capture = await captureLearningCommand({
      type: 'observation',
      scope,
      id: `signal:${input.sourceId}`,
      domain: 'agent-signal',
      evidenceRef: input.sourceId,
      configurations: result?.learningRequests ?? [
        { model: input.model, maxSteps: input.maxSteps, context: input.context, complete: false },
      ],
      outcome: state.cancelled
        ? 'cancelled'
        : !result || result.status === 'failed'
          ? 'failed'
          : 'unknown',
      applicability: 'signal-observation-only',
      budgetRef: binding.ref,
    });
    await withHarnessCoordinator((c) =>
      c.store.transaction({ userId: input.userId, agentId: input.agentId }, async (state, save) => {
        state.learning ??= [];
        if (!state.learning.some((item) => item.episode.id === capture.episode.id)) {
          if (state.learning.length >= 64) throw new Error('HARNESS_QUOTA_EXCEEDED');
          state.learning.push(capture);
          await save();
        }
      }),
    );
  };
  let result: Awaited<ReturnType<typeof executeSelfIteration>>;
  try {
    result = await executeSelfIteration({ ...input, learningBudget: binding });
  } catch (error) {
    await record();
    throw error;
  }
  await record(result);
  return result;
}
