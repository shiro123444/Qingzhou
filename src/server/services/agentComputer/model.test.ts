// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { agents, aiModels, aiProviders, users } from '@/database/schemas';

import { COMPUTER_DEEPSEEK_MODEL, resolveComputerModel } from './model';

const db = await getTestDB(),
  user = 'computer-model-owner',
  foreign = 'computer-model-other';
const decrypt = async (value: string | null) => JSON.parse(value ?? '{}');
beforeAll(async () => {
  await db.insert(users).values([{ id: user }, { id: foreign }]);
  await db
    .insert(agents)
    .values([{ id: 'model-agent', userId: user, provider: 'nexus', model: 'ordinary-chat-model' }]);
});
beforeEach(async () => {
  await db.delete(aiModels);
  await db.delete(aiProviders);
  vi.stubEnv('QINGZHOU_COMPUTER_MODEL', COMPUTER_DEEPSEEK_MODEL);
  delete process.env.QINGZHOU_COMPUTER_MODEL_PROVIDER;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.delete(users).where(eq(users.id, user));
  await db.delete(users).where(eq(users.id, foreign));
});
async function provider(id = 'nexus', owner = user, baseURL = 'https://cli.tinimodel.com/v1') {
  await db.insert(aiProviders).values({
    id,
    userId: owner,
    enabled: true,
    keyVaults: JSON.stringify({ apiKey: 'private-model-token', baseURL }),
  });
  await db.insert(aiModels).values({
    id: COMPUTER_DEEPSEEK_MODEL,
    providerId: id,
    userId: owner,
    enabled: true,
    source: 'remote',
    type: 'chat',
  });
}

it('binds the exact synchronized DeepSeek model to the owning saved gateway without changing normal chat', async () => {
  await provider();
  expect(await resolveComputerModel(db, user, 'model-agent', decrypt)).toEqual({
    model: COMPUTER_DEEPSEEK_MODEL,
    provider: 'nexus',
  });
  expect((await db.select().from(agents).where(eq(agents.id, 'model-agent')))[0].model).toBe(
    'ordinary-chat-model',
  );
  expect(JSON.stringify(await resolveComputerModel(db, user, 'model-agent', decrypt))).not.toMatch(
    /token|baseURL|apiKey/,
  );
});
it('refuses foreign owners, lookalike endpoints, disabled and built-in fallback models', async () => {
  await provider('foreign-provider', foreign);
  await expect(resolveComputerModel(db, foreign, 'model-agent', decrypt)).rejects.toThrow(
    'SCOPE_UNAVAILABLE',
  );
  await provider('nexus', user, 'https://cli.tinimodel.com.evil.test/v1');
  await expect(resolveComputerModel(db, user, 'model-agent', decrypt)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
  await db
    .update(aiProviders)
    .set({
      keyVaults: JSON.stringify({ apiKey: 'private', baseURL: 'https://cli.tinimodel.com/v1' }),
    })
    .where(eq(aiProviders.userId, user));
  await db.update(aiModels).set({ enabled: false }).where(eq(aiModels.userId, user));
  await expect(resolveComputerModel(db, user, 'model-agent', decrypt)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
  await db
    .update(aiModels)
    .set({ enabled: true, source: 'builtin' })
    .where(eq(aiModels.userId, user));
  await expect(resolveComputerModel(db, user, 'model-agent', decrypt)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
});
it('does not silently select another gateway or an unavailable explicit override', async () => {
  await provider();
  vi.stubEnv('QINGZHOU_COMPUTER_MODEL_PROVIDER', 'missing');
  await expect(resolveComputerModel(db, user, 'model-agent', decrypt)).rejects.toThrow(
    'MODEL_UNAVAILABLE',
  );
  vi.stubEnv('QINGZHOU_COMPUTER_MODEL', 'gpt-built-in-fallback');
  await expect(resolveComputerModel(db, user, 'model-agent', decrypt)).rejects.toThrow(
    'POLICY_INVALID',
  );
});
