import { harnessData, harnessDigest } from '@lobechat/agent-runtime';

import { LearningWritePendingError } from './contracts';
import { withHarnessCoordinator } from './production';

/** Learned resource mutations need their own validated surface. Preserve the complete proposal
 * instead of letting the legacy confidence gate directly mutate shared behavior.
 */
export async function stageLearnedSkillWrite(
  userId: string,
  agentId: string,
  operation: string,
  material: unknown,
): Promise<void> {
  if (process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1') return;
  const id = `intent-${await harnessDigest([userId, agentId, operation, material])}`;
  await withHarnessCoordinator((c) =>
    c.store.transaction({ userId, agentId }, async (state, save) => {
      state.intents ??= [];
      if (!state.intents.some((entry) => entry.id === id)) {
        state.intents.push({
          id,
          domain: 'managed-skill',
          operation,
          material: harnessData(material),
          status: 'pending-validation',
          at: new Date().toISOString(),
        });
        await save();
      }
    }),
  );
  throw new LearningWritePendingError(id);
}
