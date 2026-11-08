import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { musicAccounts } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

import { MusicError } from './contracts';

export const kugouDeviceSchema = z
  .object({
    dev: z.string().regex(/^[A-F\d]{32}$/u),
    dfid: z.string().max(256),
    mid: z.string().regex(/^[a-f\d]{32}$/u),
  })
  .strict();
export const kugouCredentialsSchema = z
  .object({
    appId: z.literal(3116),
    connectedAt: z.number().int(),
    device: kugouDeviceSchema,
    displayName: z.string().max(200),
    expiresAt: z.number().int(),
    id: z.string().uuid(),
    token: z.string().min(1).max(4096),
    userId: z.string().regex(/^\d{1,20}$/u),
  })
  .strict();
export const musicAccountRecordSchema = z
  .object({
    accountRevision: z.string().min(1).max(100),
    connection: kugouCredentialsSchema.optional(),
    pending: z
      .object({
        device: kugouDeviceSchema,
        expiresAt: z.number().int(),
        id: z.string().uuid(),
        key: z
          .string()
          .regex(/^[\w-]{1,256}$/u)
          .optional(),
        lastPollAt: z.number().int(),
        state: z.enum(['waiting', 'scanned']),
      })
      .strict()
      .optional(),
    state: z.enum(['disconnected', 'connected', 'expired']),
    version: z.literal(1),
  })
  .strict();
export type KugouDevice = z.infer<typeof kugouDeviceSchema>;
export type KugouCredentials = z.infer<typeof kugouCredentialsSchema>;
export type MusicAccountRecord = z.infer<typeof musicAccountRecordSchema>;
export interface StoredMusicAccount {
  record: MusicAccountRecord;
  revision: string;
}
export interface MusicAccountStore {
  read: () => Promise<StoredMusicAccount | undefined>;
  save: (
    record: MusicAccountRecord,
    expectedRevision: string | null,
  ) => Promise<StoredMusicAccount | undefined>;
}
interface GateKeeper {
  decrypt: (ciphertext: string) => Promise<{ plaintext: string; wasAuthentic: boolean }>;
  encrypt: (plaintext: string) => Promise<string>;
}

/** The encrypted envelope is bound to its Qingzhou owner, including against ciphertext row swaps. */
export class DatabaseMusicAccountStore implements MusicAccountStore {
  private gateKeeper?: Promise<GateKeeper>;
  constructor(
    private db: LobeChatDatabase,
    private userId: string,
    gateKeeper?: GateKeeper,
  ) {
    if (gateKeeper) this.gateKeeper = Promise.resolve(gateKeeper);
  }
  private gate() {
    return (this.gateKeeper ??= KeyVaultsGateKeeper.initWithEnvKey());
  }
  async read(): Promise<StoredMusicAccount | undefined> {
    const [row] = await this.db
      .select()
      .from(musicAccounts)
      .where(eq(musicAccounts.userId, this.userId))
      .limit(1);
    if (!row) return;
    const decoded = await (await this.gate()).decrypt(row.encryptedState);
    if (!decoded.wasAuthentic) throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 503);
    const value = z
      .object({ owner: z.string(), record: musicAccountRecordSchema })
      .strict()
      .parse(JSON.parse(decoded.plaintext));
    if (value.owner !== this.userId) throw new MusicError('MUSIC_ACCOUNT_UNAVAILABLE', 503);
    return { record: value.record, revision: row.revision };
  }
  async save(record: MusicAccountRecord, expectedRevision: string | null) {
    const revision = randomUUID();
    const encryptedState = await (
      await this.gate()
    ).encrypt(
      JSON.stringify({ owner: this.userId, record: musicAccountRecordSchema.parse(record) }),
    );
    const values = { encryptedState, revision, updatedAt: new Date() };
    const rows =
      expectedRevision === null
        ? await this.db
            .insert(musicAccounts)
            .values({ ...values, userId: this.userId })
            .onConflictDoNothing()
            .returning({ revision: musicAccounts.revision })
        : await this.db
            .update(musicAccounts)
            .set(values)
            .where(
              and(
                eq(musicAccounts.userId, this.userId),
                eq(musicAccounts.revision, expectedRevision),
              ),
            )
            .returning({ revision: musicAccounts.revision });
    return rows.length ? { record, revision } : undefined;
  }
}
