// @vitest-environment node
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { AiModelModel } from '../../../models/aiModel';
import { AiProviderModel } from '../../../models/aiProvider';
import { aiModels, aiProviders, users } from '../../../schemas';
import { AiInfraRepos } from '../index';

const db = await getTestDB();
const alice = 'remote-catalog-alice';
const bob = 'remote-catalog-bob';
const model = new AiModelModel(db, alice);
const provider = new AiProviderModel(db, alice);

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [alice, bob]));
  await db.insert(users).values([{ id: alice }, { id: bob }]);
  await db.insert(aiProviders).values([
    {
      id: 'nexus',
      userId: alice,
      enabled: true,
      settings: { sdkType: 'openai', showApiKey: true },
    },
    { id: 'openai', userId: alice, enabled: true },
    { id: 'nexus', userId: bob, enabled: true },
  ]);
  await db.insert(aiModels).values([
    {
      id: 'gpt-image-2',
      providerId: 'nexus',
      userId: alice,
      enabled: true,
      type: 'image',
      source: 'builtin',
      sort: 4,
      config: { custom: true },
      settings: { extendParams: ['reasoningBudgetToken'] },
    },
    {
      id: 'unsupported-builtin',
      providerId: 'nexus',
      userId: alice,
      enabled: true,
      source: 'builtin',
    },
    { id: 'other-provider-model', providerId: 'openai', userId: alice, enabled: true },
    { id: 'other-account-model', providerId: 'nexus', userId: bob, enabled: true },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(users).where(inArray(users.id, [alice, bob]));
});

it('replaces one account/provider catalog, deduplicates IDs and preserves surviving preferences', async () => {
  await model.replaceRemoteModels('nexus', [
    { id: 'gpt-image-2', enabled: false, type: 'chat' },
    { id: 'new-upstream-model', enabled: false, type: 'chat' },
    { id: 'new-upstream-model', enabled: false, type: 'chat' },
  ]);
  const rows = await model.getModelListByProviderId('nexus');
  expect(rows.map((row) => row.id).sort()).toEqual(['gpt-image-2', 'new-upstream-model']);
  expect(rows.every((row) => row.source === 'remote')).toBe(true);
  expect(rows.find((row) => row.id === 'gpt-image-2')).toMatchObject({
    enabled: true,
    type: 'image',
    config: { custom: true },
    settings: { extendParams: ['reasoningBudgetToken'] },
  });
  expect(await provider.findById('nexus')).toMatchObject({
    settings: { modelListSource: 'remote', sdkType: 'openai', showApiKey: true },
  });
  expect(await provider.getRemoteModelProviderIds()).toEqual(['nexus']);
  expect(await new AiProviderModel(db, bob).getRemoteModelProviderIds()).toEqual([]);
  expect(await model.getModelListByProviderId('openai')).toHaveLength(1);
  expect(await new AiModelModel(db, bob).getModelListByProviderId('nexus')).toHaveLength(1);
});

it('keeps settings, model selectors and subsequent synchronization restricted to the remote catalog', async () => {
  await model.replaceRemoteModels('nexus', [
    { id: 'gpt-image-2', enabled: false, type: 'chat' },
    { id: 'new-upstream-model', enabled: false, type: 'chat' },
  ]);
  // Even a later builtin preference row must not reintroduce an unsupported model.
  await model.toggleModelEnabled({ id: 'unsupported-builtin', providerId: 'nexus', enabled: true });
  const repo = new AiInfraRepos(db, alice, { nexus: { enabled: true } });
  vi.spyOn(repo as any, 'fetchBuiltinModels').mockResolvedValue([
    { id: 'gpt-image-2', type: 'image', displayName: 'Glass Image', enabled: true },
    { id: 'unsupported-builtin', type: 'chat', enabled: true },
  ]);
  const list = await repo.getAiProviderModelList('nexus');
  expect(list.map((row) => row.id).sort()).toEqual(['gpt-image-2', 'new-upstream-model']);
  expect(list.find((row) => row.id === 'gpt-image-2')?.type).toBe('image');
  expect(
    (await repo.getEnabledModels())
      .filter((row) => row.providerId === 'nexus')
      .map((row) => row.id),
  ).toEqual(['gpt-image-2']);
  expect(
    (await repo.getEnabledModels(false)).filter((row) => row.providerId === 'nexus'),
  ).toHaveLength(2);
  await model.replaceRemoteModels('nexus', [
    { id: 'gpt-image-2', enabled: false, type: 'image' },
    { id: 'latest-upstream-model', enabled: false, type: 'chat' },
  ]);
  expect((await repo.getAiProviderModelList('nexus')).map((row) => row.id).sort()).toEqual([
    'gpt-image-2',
    'latest-upstream-model',
  ]);
});

it('keeps the existing catalog on empty input and rolls back a failed replacement', async () => {
  const before = await model.getModelListByProviderId('nexus');
  expect(await model.replaceRemoteModels('nexus', [])).toEqual([]);
  await expect(
    model.replaceRemoteModels('nexus', [
      { id: 'new-model', displayName: 'x'.repeat(201), enabled: false, type: 'chat' },
    ]),
  ).rejects.toThrow();
  expect(await model.getModelListByProviderId('nexus')).toEqual(before);
  expect((await provider.findById('nexus'))?.settings?.modelListSource).toBeUndefined();
  expect(await db.select().from(aiModels).where(eq(aiModels.userId, alice))).toHaveLength(3);
});
