// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { musicAccounts, users } from '@/database/schemas';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

import { DatabaseMusicAccountStore, type MusicAccountRecord } from './account-store';

// Reuse the database workspace's PGlite dependency and real migration runner.
const db = await getTestDB();
const aliceId = 'music-account-test-alice';
const bobId = 'music-account-test-bob';
await db.insert(users).values([{ id: aliceId }, { id: bobId }]);
const gate = new KeyVaultsGateKeeper(
  await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
);
afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [aliceId, bobId]));
});

it('uses real encrypted owner-bound DB records and atomic revisions with the migration schema', async () => {
  const alice = new DatabaseMusicAccountStore(db, aliceId, gate);
  const bob = new DatabaseMusicAccountStore(db, bobId, gate);
  const record: MusicAccountRecord = {
    accountRevision: randomUUID(),
    state: 'connected',
    version: 1,
    connection: {
      appId: 3116,
      id: randomUUID(),
      token: 'secret-provider-token',
      userId: '12345',
      displayName: 'Listener',
      connectedAt: Date.now(),
      expiresAt: Date.now() + 100000,
      device: { mid: 'a'.repeat(32), dev: 'A'.repeat(32), dfid: '-' },
    },
  };
  const saved = (await alice.save(record, null))!;
  expect((await alice.read())?.record).toEqual(record);
  expect(await bob.read()).toBeUndefined();
  const [row] = await db.select().from(musicAccounts).where(eq(musicAccounts.userId, aliceId));
  expect(row.encryptedState).not.toMatch(/secret-provider-token|Listener|12345/u);
  expect(row.encryptedState.split(':')).toHaveLength(3);
  await db
    .insert(musicAccounts)
    .values({ userId: bobId, revision: randomUUID(), encryptedState: row.encryptedState });
  await expect(bob.read()).rejects.toThrow('MUSIC_ACCOUNT_UNAVAILABLE');
  const disconnected: MusicAccountRecord = {
    state: 'disconnected',
    accountRevision: randomUUID(),
    version: 1,
  };
  expect(await alice.save(disconnected, saved.revision)).toBeDefined();
  expect(await alice.save(record, saved.revision)).toBeUndefined();
  expect((await alice.read())?.record).toEqual(disconnected);
  await db.delete(users).where(eq(users.id, aliceId));
  expect(await alice.read()).toBeUndefined();
});
