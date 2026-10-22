import type { LobeChatDatabase } from '@lobechat/database';

import { AgentService } from '@/server/services/agent';
import { AgentDocumentsService } from '@/server/services/agentDocuments';
import { captureOperationHarness } from '@/server/services/agentRuntime/harness';
import { resolveOperationSkills } from '@/server/services/agentRuntime/skills';

/** Reconstruct the authoring source inside the publication transaction. No model or tool work. */
export async function readCurrentHarnessSource(
  db: LobeChatDatabase,
  userId: string,
  agentId: string,
) {
  const config = await new AgentService(db, userId).getAgentConfig(agentId);
  if (!config) throw new Error('HARNESS_SCOPE_NOT_FOUND');
  const documents = await new AgentDocumentsService(db, userId).getAgentDocuments(agentId);
  const { operationSkillSet, skillVersions } = await resolveOperationSkills(
    db,
    userId,
    config.plugins ?? [],
    agentId,
    documents,
  );
  const captured = await captureOperationHarness({
    agentConfig: config,
    agentDocuments: documents,
    appContext: { agentId },
    harnessSource: {
      agentConfig: { ...config },
      promptSegments: [{ kind: 'author', content: config.systemRole ?? '' }],
      skillVersions,
    },
    initialContext: { phase: 'user_input' } as any,
    modelRuntimeConfig: { model: config.model, provider: config.provider },
    operationId: 'publication-source-check',
    operationSkillSet,
    toolSet: { manifestMap: {}, tools: [] },
    userId,
  });
  return captured.revision;
}
