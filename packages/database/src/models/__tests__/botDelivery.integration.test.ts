// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '../../type';
import { BotDeliveryModel, type DeliveryEnvelope } from '../botDelivery';

const connectionString = process.env.CHANNEL_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/qingzhou_channel_test'
  )
    throw new Error(
      'Channel integration tests require a dedicated local qingzhou_channel_test database',
    );
}

describe.skipIf(!connectionString)('durable bot delivery (real PostgreSQL)', () => {
  const namespace = `channel_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${namespace}` });
  const model = new BotDeliveryModel(drizzle(pool) as unknown as LobeChatDatabase);
  const envelope = (eventKey = 'event-1', userId = 'owner'): DeliveryEnvelope => ({
    eventKey,
    intentHash: 'hash-1',
    operationId: 'operation-1',
    payload: { content: 'hello' },
    priority: 100,
    scopeKey: 'scope-1',
    userId,
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(
      await readFile(
        new URL('../../../migrations/0108_bot_delivery_queues.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE bot_delivery_audits, bot_delivery_ledgers, bot_delivery_jobs, users CASCADE',
    );
    await pool.query("INSERT INTO users VALUES ('owner'), ('other')");
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });

  it('deduplicates concurrent receipts and preserves the first payload', async () => {
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () => model.enqueue('inbox', envelope())),
    );
    expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM bot_delivery_jobs')).rows[0].count,
    ).toBe(1);
    await expect(model.enqueue('inbox', { ...envelope(), intentHash: 'changed' })).rejects.toThrow(
      'payload_conflict',
    );
  });

  it('only grants one owner when workers compete for a job', async () => {
    await model.enqueue('inbox', envelope());
    const claims = await Promise.all([model.claim('inbox'), model.claim('inbox')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('skips a locked row without blocking unrelated work', async () => {
    await model.enqueue('inbox', envelope('a'));
    await model.enqueue('inbox', envelope('b'));
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query("SELECT id FROM bot_delivery_jobs WHERE id = 'inbox:a' FOR UPDATE");
      expect((await model.claim('inbox'))?.id).toBe('inbox:b');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('atomically transfers outbox and clears both payloads after delivery', async () => {
    await model.enqueue('outbox', envelope());
    expect(await model.transfer((await model.claim('outbox'))!)).toBe(true);
    const inbox = (await model.claim('inbox'))!;
    expect(await model.delivered(inbox)).toBe(true);
    const rows = (await pool.query('SELECT status, payload FROM bot_delivery_jobs')).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'delivered' && r.payload === null)).toBe(true);
  });

  it('rolls back transfer when the destination event conflicts', async () => {
    await model.enqueue('outbox', envelope());
    await model.enqueue('inbox', { ...envelope(), intentHash: 'other' });
    await expect(model.transfer((await model.claim('outbox'))!)).rejects.toThrow(
      'payload_conflict',
    );
    expect(
      (await pool.query("SELECT status, payload FROM bot_delivery_jobs WHERE role = 'outbox'"))
        .rows[0],
    ).toMatchObject({ status: 'running', payload: JSON.stringify(envelope().payload) });
  });

  it('rejects a dead worker after lease recovery and reassignment', async () => {
    await model.enqueue('inbox', envelope());
    const stale = (await model.claim('inbox'))!;
    await pool.query("UPDATE bot_delivery_jobs SET lease_expires_at = now() - interval '1 second'");
    expect(await model.recoverExpiredJobs()).toBe(1);
    await pool.query('UPDATE bot_delivery_jobs SET next_attempt_at = now()');
    const fresh = (await model.claim('inbox'))!;
    expect(fresh.leaseOwner).not.toBe(stale.leaseOwner);
    expect(await model.delivered(stale)).toBe(false);
    expect(await model.renewJob({ id: stale.id, owner: stale.leaseOwner! })).toBe(false);
    expect(await model.delivered(fresh)).toBe(true);
  });

  it('keeps uncertain platform outcomes out of automatic retries', async () => {
    await model.enqueue('inbox', envelope());
    await model.failed((await model.claim('inbox'))!, 'unknown_delivery', true);
    expect(await model.recoverExpiredJobs()).toBe(0);
    expect(await model.claim('inbox')).toBeNull();
    expect((await model.list('owner')).items[0].status).toBe('unknown');
  });

  it('yields between chunks without consuming the failure budget', async () => {
    await model.enqueue('inbox', envelope());
    await model.failed((await model.claim('inbox'))!, 'budget_exhausted', false);
    expect((await model.list('owner')).items[0]).toMatchObject({ attempts: 0, status: 'pending' });
  });

  it('isolates owners and records manual dead-letter recovery', async () => {
    await model.enqueue('inbox', envelope());
    const job = (await model.claim('inbox'))!;
    await model.failed({ ...job, attempts: 8 }, 'backend_unavailable', false);
    expect((await model.list('other')).items).toHaveLength(0);
    await expect(
      model.retryDead('other', {
        jobId: job.id,
        evidence: 'test evidence',
        note: 'recovered configuration',
      }),
    ).rejects.toThrow('job_not_retryable');
    await model.retryDead('owner', {
      jobId: job.id,
      evidence: 'test evidence',
      note: 'recovered configuration',
    });
    expect((await model.inspect('owner', 'scope-1')).audits[0].action).toBe('retry_dead');
  });

  it('uses revision checks and audit transactions for unknown reconciliation', async () => {
    await model.importLedger('owner', 'scope-1', {
      effects: { 'completion/chunk:0': 'unknown_delivery' },
      events: {},
    });
    await pool.query("UPDATE bot_delivery_ledgers SET updated_at = now() - interval '61 seconds'");
    const input = {
      effectId: 'completion/chunk:0',
      evidence: 'platform message 123',
      expectedRevision: 0,
      note: 'confirmed on the test platform',
      resolution: 'confirmed_delivered' as const,
      scopeKey: 'scope-1',
    };
    await expect(model.reconcile('other', input)).rejects.toThrow('reconciliation_conflict');
    expect(await model.reconcile('owner', input)).toEqual({ revision: 1 });
    await expect(model.reconcile('owner', input)).rejects.toThrow('reconciliation_conflict');
    expect((await model.getLedger('owner', 'scope-1'))?.state.effects['completion/chunk:0']).toBe(
      'delivered',
    );
  });
});
