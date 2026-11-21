// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { agents, aiModels, aiProviders, users } from '@/database/schemas';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { AiAgentService } from '@/server/services/aiAgent';

import { AgentComputerService } from './index';

const db = await getTestDB(),
  userId = `computer-start-${randomUUID()}`,
  agentId = `agent-${randomUUID()}`;
const registration = {
  id: 'test',
  binding: 'test',
  capabilities: [] as const,
  load: async () => ({
    execute: async () => {
      throw new Error('UNEXPECTED_PROVIDER_START');
    },
  }),
};
beforeAll(async () => {
  await db.insert(users).values({ id: userId });
  await db.insert(agents).values({
    id: agentId,
    userId,
    model: 'ordinary-model',
    provider: 'nexus',
    chatConfig: { enableAgentMode: false, autoCreateTopicThreshold: 2 },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});
it('starts a durable DeepSeek task with real saved-vault selection without changing normal chat', async () => {
  vi.stubEnv('KEY_VAULTS_SECRET', randomBytes(32).toString('base64'));
  vi.stubEnv('QINGZHOU_COMPUTER_MODEL_PROVIDER', 'nexus');
  vi.stubEnv('QINGZHOU_COMPUTER_MODEL', 'deepseek-v4.1-flash');
  const gate = await KeyVaultsGateKeeper.initWithEnvKey();
  await db.insert(aiProviders).values({
    id: 'nexus',
    userId,
    enabled: true,
    keyVaults: await gate.encrypt(
      JSON.stringify({ apiKey: 'fixture-key', baseURL: 'https://cli.tinimodel.com/v1' }),
    ),
  });
  await db.insert(aiModels).values({
    id: 'deepseek-v4.1-flash',
    providerId: 'nexus',
    userId,
    enabled: true,
    source: 'remote',
    type: 'chat',
  });
  const execute = vi
    .spyOn(AiAgentService.prototype, 'execAgent')
    .mockResolvedValue({ success: true, operationId: 'operation', topicId: 'topic' } as Awaited<
      ReturnType<AiAgentService['execAgent']>
    >);
  const uiAttention = {
    area: 'computer' as const,
    evidence: 'focus' as const,
    observedAt: Date.now(),
  };
  await new AgentComputerService(db, userId, registration).startTask(
    agentId,
    'Use my browser',
    uiAttention,
  );
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId,
      model: 'deepseek-v4.1-flash',
      provider: 'nexus',
      computerTask: true,
      uiAttention,
      userInterventionConfig: { approvalMode: 'manual' },
    }),
  );
  const [saved] = await db.select().from(agents).where(eq(agents.id, agentId));
  expect(saved.model).toBe('ordinary-model');
  expect(saved.chatConfig?.enableAgentMode).toBe(false);
});
it('refuses foreign assistant IDs before starting a task', async () => {
  const execute = vi.spyOn(AiAgentService.prototype, 'execAgent');
  await expect(
    new AgentComputerService(db, 'other-owner', registration).startTask(agentId, 'Use my browser'),
  ).rejects.toThrow('NOT_FOUND');
  expect(execute).not.toHaveBeenCalled();
});
