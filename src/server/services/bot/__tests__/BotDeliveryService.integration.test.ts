// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import {
  BOT_CALLBACK_INTENT_READY_SET,
  botCallbackIntentKey,
} from '@/server/modules/AgentRuntime/callbackIntent';
import * as redisRuntime from '@/server/modules/AgentRuntime/redis';

import { BotDeliveryService } from '../BotDeliveryService';
import {
  CallbackDeliveryError,
  CallbackDeliverySession,
  callbackScopeKey,
  type LedgerBackend,
  type LedgerState,
} from '../callbackLedger';
import { PostgresCallbackLedger } from '../postgresCallbackLedger';

const handleCallback = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../BotCallbackService', () => ({
  BotCallbackService: class {
    constructor(
      _db: unknown,
      private readonly ledger: LedgerBackend,
    ) {}
    handleCallback(body: unknown) {
      return handleCallback(body, this.ledger);
    }
  },
}));

const databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = process.env.CHANNEL_TEST_REDIS_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/qingzhou_channel_test'
  )
    throw new Error('Use a dedicated local qingzhou_channel_test database');
}
if (redisUrl) {
  const url = new URL(redisUrl);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.port === '6379' ||
    url.pathname !== '/15'
  )
    throw new Error('Use a disposable local Redis server on a dedicated port and database 15');
}

describe.skipIf(!databaseUrl || !redisUrl)(
  'callback recovery with real PostgreSQL and Redis',
  () => {
    const namespace = `recovery_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${namespace}`,
    });
    const db = drizzle(pool) as unknown as LobeChatDatabase;
    const service = new BotDeliveryService(db);
    const redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 0 });
    const stagedKeys = new Set<string>();
    const payload = (operationId = randomUUID()) => ({
      applicationId: 'app',
      content: 'completed task',
      operationId,
      platformThreadId: 'qq:thread',
      type: 'completion' as const,
      userId: 'owner',
    });
    async function stage(intents: unknown[]) {
      const key = botCallbackIntentKey(randomUUID(), 0);
      stagedKeys.add(key);
      await redis.set(key, JSON.stringify(intents));
      await redis.sadd(BOT_CALLBACK_INTENT_READY_SET, key);
      return key;
    }

    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
      await pool.query(
        await readFile(
          new URL(
            '../../../../../packages/database/migrations/0108_bot_delivery_queues.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      await redis.connect();
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE bot_delivery_audits, bot_delivery_ledgers, bot_delivery_jobs, users CASCADE',
      );
      await pool.query("INSERT INTO users VALUES ('owner')");
      vi.spyOn(redisRuntime, 'getAgentRuntimeRedisClient').mockReturnValue(redis);
      handleCallback.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
      // The opt-in server is disposable. Never flush the application's Redis.
      await redis.del(
        BOT_CALLBACK_INTENT_READY_SET,
        'bot:delivery:scan-cursor:v1',
        'bot:delivery:scan-rotation:v1',
        ...stagedKeys,
      );
      stagedKeys.clear();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await redis.quit();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    });

    it('recovers staged intents and ignores a replay after delivery', async () => {
      const intent = payload();
      const key = await stage([intent]);
      expect(await service.sweep()).toMatchObject({ staged: 1, transferred: 1, delivered: 1 });
      expect(await redis.get(key)).toBeNull();
      const jobs = (await pool.query('SELECT status, payload FROM bot_delivery_jobs')).rows;
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.status === 'delivered' && job.payload === null)).toBe(true);

      await stage([intent]);
      expect(await new BotDeliveryService(db).sweep()).toMatchObject({
        staged: 1,
        transferred: 0,
        delivered: 0,
      });
      expect(handleCallback).toHaveBeenCalledTimes(1);
    });

    it('retains Redis intents after an SQL write failure and recovers on the next sweep', async () => {
      const key = await stage([payload()]);
      vi.spyOn(service.model, 'enqueue').mockRejectedValueOnce(new Error('SQL temporarily down'));
      expect(await service.sweep()).toMatchObject({ stagingErrors: 1, staged: 0, delivered: 0 });
      expect(await redis.get(key)).not.toBeNull();
      expect(await redis.sismember(BOT_CALLBACK_INTENT_READY_SET, key)).toBe(1);
      expect(await new BotDeliveryService(db).sweep()).toMatchObject({ staged: 1, delivered: 1 });
      expect(await redis.get(key)).toBeNull();
    });

    it('preserves a concurrent staging update when an older SQL transfer acknowledges late', async () => {
      const first = payload();
      const next = payload();
      const key = await stage([first]);
      const enqueue = service.model.enqueue.bind(service.model);
      vi.spyOn(service.model, 'enqueue').mockImplementationOnce(async (role, envelope) => {
        const result = await enqueue(role, envelope);
        await redis.set(key, JSON.stringify([first, next]));
        return result;
      });
      expect(await service.sweep()).toMatchObject({ staged: 1, delivered: 1 });
      expect(JSON.parse((await redis.get(key))!)).toEqual([first, next]);
      expect(await new BotDeliveryService(db).sweep()).toMatchObject({ staged: 2, delivered: 1 });
      expect(handleCallback).toHaveBeenCalledTimes(2);
      expect(await redis.get(key)).toBeNull();
    });

    it('delivers a valid final reply while retaining an invalid progress intent', async () => {
      const invalid = { ...payload(), type: 'step' };
      const final = payload();
      const key = await stage([invalid, final]);
      expect(await service.sweep()).toMatchObject({ stagingErrors: 1, staged: 1, delivered: 1 });
      expect(JSON.parse((await redis.get(key))!)).toEqual([invalid]);
      expect(handleCallback).toHaveBeenCalledWith(final, expect.anything());
    });

    it('keeps unknown platform outcomes quarantined across worker instances', async () => {
      await stage([payload()]);
      handleCallback.mockRejectedValueOnce(new CallbackDeliveryError('unknown_delivery'));
      expect(await service.sweep()).toMatchObject({ deferred: 1, delivered: 0 });
      expect((await service.model.list('owner')).items.map((job) => job.status)).toContain(
        'unknown',
      );
      expect(await new BotDeliveryService(db).sweep()).toMatchObject({ delivered: 0, deferred: 0 });
      expect(handleCallback).toHaveBeenCalledTimes(1);
    });

    it('discards staged plaintext for a deleted account without dispatching', async () => {
      const key = await stage([{ ...payload(), userId: 'deleted-user' }]);
      expect(await service.sweep()).toMatchObject({ discardedDeletedUsers: 1, staged: 0 });
      expect(await redis.get(key)).toBeNull();
      expect(handleCallback).not.toHaveBeenCalled();
    });

    it('resumes only unsent chunks through the real SQL ledger after a worker restart', async () => {
      const intent = payload();
      const send = vi.fn().mockResolvedValue('message-id');
      let interrupt = true;
      handleCallback.mockImplementation(async (body, backend) => {
        const session = await CallbackDeliverySession.begin(body, 'fingerprint', backend);
        if (!session) return;
        try {
          const chunks = await session.plan(['first', 'second']);
          for (const [index, chunk] of chunks.entries()) {
            await session.effect(`chunk:${index}`, () => send(chunk));
            if (interrupt) {
              interrupt = false;
              throw new CallbackDeliveryError('backend_unavailable');
            }
          }
          await session.complete();
        } finally {
          await session.release();
        }
      });
      await stage([intent]);
      expect(await service.sweep()).toMatchObject({ delivered: 0, deferred: 1 });
      expect(send.mock.calls).toEqual([['first']]);
      await pool.query('UPDATE bot_delivery_jobs SET next_attempt_at = now()');
      expect(await new BotDeliveryService(db).sweep()).toMatchObject({ delivered: 1, deferred: 0 });
      expect(send.mock.calls).toEqual([['first'], ['second']]);
    });

    it('restores native stream receipts across workers and clears draft text after final delivery', async () => {
      const intent = payload();
      const firstReceipt = {
        content: 'private cumulative QQ prefix',
        final: false,
        index: 0,
        msgSeq: 4,
        replyMessageId: 'qq-reply',
        streamId: 'qq-stream',
      };
      type StreamReceipt = typeof firstReceipt;
      const send = vi.fn(async (receipt: StreamReceipt) => receipt);
      const readState = async () =>
        (
          await pool.query<{ state: LedgerState }>(
            'SELECT state FROM bot_delivery_ledgers WHERE scope_key = $1',
            [callbackScopeKey(intent)],
          )
        ).rows[0].state;
      const first = await CallbackDeliverySession.begin(
        { ...intent, stepIndex: 1, type: 'step' },
        'step-one',
        new PostgresCallbackLedger(db, 'owner'),
      );
      expect(first).not.toBeNull();
      try {
        await first!.plan({ content: firstReceipt.content, mode: 'qq-stream' });
        await first!.effectWithReceipt('qq-stream', () => send(firstReceipt));
        await first!.complete();
      } finally {
        await first!.release();
      }
      expect((await readState()).transportReceipts).toEqual({
        'step:1/qq-stream': firstReceipt,
      });

      const secondIntent = { ...intent, stepIndex: 2, type: 'step' as const };
      const second = await CallbackDeliverySession.begin(
        secondIntent,
        'step-two',
        new PostgresCallbackLedger(db, 'owner'),
      );
      expect(second).not.toBeNull();
      let secondReceipt: StreamReceipt;
      try {
        const previous = second!.transportReceiptEntries<StreamReceipt>('qq-stream')[0].value;
        expect(previous).toEqual(firstReceipt);
        secondReceipt = {
          ...previous,
          content: `${previous.content}\n\nprivate second step`,
          index: previous.index + 1,
        };
        await second!.plan({ content: secondReceipt.content, mode: 'qq-stream' });
        await second!.effectWithReceipt('qq-stream', () => send(secondReceipt));
        // Simulate a worker stopping after platform acknowledgement but before event completion.
      } finally {
        await second!.release();
      }

      const resumed = await CallbackDeliverySession.begin(
        secondIntent,
        'step-two',
        new PostgresCallbackLedger(db, 'owner'),
      );
      expect(resumed).not.toBeNull();
      try {
        expect(await resumed!.effectWithReceipt('qq-stream', () => send(secondReceipt))).toEqual(
          secondReceipt,
        );
        await resumed!.complete();
      } finally {
        await resumed!.release();
      }
      expect(send).toHaveBeenCalledTimes(2);
      expect((await readState()).transportReceipts?.['step:2/qq-stream']).toEqual(secondReceipt);

      const final = await CallbackDeliverySession.begin(
        intent,
        'final',
        new PostgresCallbackLedger(db, 'owner'),
      );
      expect(final).not.toBeNull();
      try {
        const previous = final!
          .transportReceiptEntries<StreamReceipt>('qq-stream')
          .map(({ value }) => value)
          .sort((left, right) => right.index - left.index)[0];
        expect(previous).toEqual(secondReceipt);
        const finalReceipt = {
          ...previous,
          content: `${previous.content}\n\nprivate final answer`,
          final: true,
          index: previous.index + 1,
        };
        await final!.plan({ content: finalReceipt.content, mode: 'qq-stream' });
        await final!.effectWithReceipt('qq-stream', () => send(finalReceipt));
        await final!.complete({ redactReceiptFields: ['content'] });
      } finally {
        await final!.release();
      }

      const state = await readState();
      expect(state.transportReceipts).toEqual({
        'completion/qq-stream': {
          final: true,
          index: 2,
          msgSeq: 4,
          replyMessageId: 'qq-reply',
          streamId: 'qq-stream',
        },
        'step:1/qq-stream': {
          final: false,
          index: 0,
          msgSeq: 4,
          replyMessageId: 'qq-reply',
          streamId: 'qq-stream',
        },
        'step:2/qq-stream': {
          final: false,
          index: 1,
          msgSeq: 4,
          replyMessageId: 'qq-reply',
          streamId: 'qq-stream',
        },
      });
      expect(JSON.stringify(state)).not.toContain('private');
      expect(state.events.completion.delivered).toBe(true);
      expect(
        await CallbackDeliverySession.begin(
          intent,
          'final',
          new PostgresCallbackLedger(db, 'owner'),
        ),
      ).toBeNull();
      expect(send.mock.calls.map(([receipt]) => receipt.index)).toEqual([0, 1, 2]);
    });
  },
);
