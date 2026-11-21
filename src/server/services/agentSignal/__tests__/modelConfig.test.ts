// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { INBOX_SESSION_ID } from '@lobechat/const';
import { agents, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { resolveAgentSignalModelConfig } from '../modelConfig';

const db = await getTestDB();
const owner = `signal-model-${randomUUID()}`,
  foreign = `signal-model-${randomUUID()}`;
let agentId: string;
beforeAll(async () => {
  await db.insert(users).values([{ id: owner }, { id: foreign }]);
  const [agent] = await db
    .insert(agents)
    .values({
      userId: owner,
      model: 'available-remote-model',
      provider: 'custom-provider',
    })
    .returning();
  agentId = agent.id;
  await db.insert(agents).values({
    userId: owner,
    slug: INBOX_SESSION_ID,
    model: 'inbox-model',
    provider: 'inbox-provider',
  });
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await db.delete(users).where(eq(users.id, foreign));
});
it('uses the owning agent model/provider pair rather than the built-in mini model', async () => {
  expect(await resolveAgentSignalModelConfig(db, owner, agentId)).toEqual({
    model: 'available-remote-model',
    provider: 'custom-provider',
  });
});
it('refuses a foreign or missing agent instead of silently paying for a default model', async () => {
  await expect(resolveAgentSignalModelConfig(db, foreign, agentId)).rejects.toThrow(
    'MODEL_SCOPE_UNAVAILABLE',
  );
  await expect(resolveAgentSignalModelConfig(db, owner, 'missing')).rejects.toThrow(
    'MODEL_SCOPE_UNAVAILABLE',
  );
});
it('uses the owned inbox for user-scoped sources and fails clearly when no model is configured', async () => {
  expect(await resolveAgentSignalModelConfig(db, owner)).toEqual({
    model: 'inbox-model',
    provider: 'inbox-provider',
  });
  await expect(resolveAgentSignalModelConfig(db, foreign)).rejects.toThrow('MODEL_NOT_CONFIGURED');
});
