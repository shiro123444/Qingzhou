// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '../../type';
import { BotInboundModel } from '../botInbound';

const connectionString = process.env.CHANNEL_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/qingzhou_channel_test'
  )
    throw new Error('Use a dedicated local qingzhou_channel_test database');
}
describe.skipIf(!connectionString)('platform inbox and sessions (real PostgreSQL)', () => {
  const namespace = `inbound_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${namespace}` });
  const db = drizzle(pool) as unknown as LobeChatDatabase;
  const model = new BotInboundModel(db);
  const otherWorker = new BotInboundModel(db);
  const input = (id = 'a', extra = {}) => ({
    id,
    userId: 'owner',
    platform: 'qq',
    applicationId: 'app',
    threadId: 'thread',
    eventId: id,
    payload: '{"text":"hello"}',
    payloadHash: 'hash',
    ...extra,
  });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(
      'CREATE TABLE agent_operations (id text PRIMARY KEY, user_id text NOT NULL, status text NOT NULL)',
    );
    for (const migration of ['0108_bot_delivery_queues.sql', '0109_bot_inbound_sessions.sql'])
      await pool.query(
        await readFile(new URL(`../../../migrations/${migration}`, import.meta.url), 'utf8'),
      );
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE bot_inbound_events, bot_execution_sessions, bot_polling_cursors, bot_delivery_audits, agent_operations, users CASCADE',
    );
    await pool.query("INSERT INTO users VALUES ('owner'), ('other')");
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });
  it('durably deduplicates concurrent receipt retries and rejects changed content', async () => {
    await Promise.all([model.enqueue(input()), otherWorker.enqueue(input())]);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM bot_inbound_events')).rows[0].count,
    ).toBe(1);
    await expect(model.enqueue(input('a', { payloadHash: 'changed' }))).rejects.toThrow(
      'inbound_payload_conflict',
    );
  });
  it('serializes a thread while independently claiming another installation', async () => {
    await model.enqueue(input('a'));
    await model.enqueue(input('b'));
    await model.enqueue(input('c', { applicationId: 'second-app' }));
    const claims = await Promise.all([model.claim(), otherWorker.claim()]);
    expect(claims.map((j) => j?.id).sort()).toEqual(['a', 'c']);
    expect(await model.claim()).toBeNull();
    await model.finish(claims.find((j) => j?.id === 'a')!);
    expect((await model.claim())?.id).toBe('b');
  });
  it('keeps /stop available while a previous dispatch has an uncertain result', async () => {
    await model.enqueue(input('a'));
    await model.fail((await model.claim())!, true);
    await model.enqueue(input('b'));
    await model.enqueue(input('stop', { isControl: true }));
    expect((await otherWorker.claim())?.id).toBe('stop');
    expect(await model.claim()).toBeNull();
  });
  it('recovers pre-dispatch crashes but quarantines crashes after dispatch begins', async () => {
    await model.enqueue(input('a'));
    const stale = (await model.claim())!;
    await pool.query(
      "UPDATE bot_inbound_events SET lease_expires_at = now() - interval '1 second'",
    );
    expect(await model.recover()).toBe(1);
    const next = (await otherWorker.claim())!;
    expect(await model.finish(stale)).toBe(false);
    expect(await model.beginDispatch(next)).toBe(true);
    await pool.query(
      "UPDATE bot_inbound_events SET lease_expires_at = now() - interval '1 second'",
    );
    await model.recover();
    expect(await model.claim()).toBeNull();
    expect((await model.list('owner'))[0].status).toBe('unknown');
  });
  it('does not consume the retry budget when another instance owns the session', async () => {
    await model.enqueue(input());
    const job = (await model.claim())!;
    await model.beginDispatch(job);
    await model.fail({ ...job, attempts: 8 }, false, 'session_busy');
    expect((await model.list('owner'))[0]).toMatchObject({ status: 'pending', attempts: 7 });
  });
  it('clears processed payloads and isolates diagnostic reads by owner', async () => {
    await model.enqueue(input());
    await model.finish((await model.claim())!);
    expect((await pool.query('SELECT payload FROM bot_inbound_events')).rows[0].payload).toBeNull();
    expect(await model.list('other')).toEqual([]);
    expect((await model.list('owner'))[0]).not.toHaveProperty('payload');
  });
  it('requires fresh owner evidence for recovery and writes an audit', async () => {
    await model.enqueue(input());
    await model.fail((await model.claim())!, true);
    await pool.query("UPDATE bot_inbound_events SET updated_at = now() - interval '61 seconds'");
    const row = (await model.list('owner'))[0];
    const recovery = {
      id: row.id,
      expectedUpdatedAt: row.updatedAt.toISOString(),
      resolution: 'retry' as const,
      note: 'Checked conversation',
      evidence: 'No tool operation or reply observed',
    };
    await expect(model.reconcile('other', recovery)).rejects.toThrow(
      'inbound_reconciliation_conflict',
    );
    await expect(
      model.reconcile('owner', { ...recovery, expectedUpdatedAt: new Date().toISOString() }),
    ).rejects.toThrow();
    await model.reconcile('owner', recovery);
    await expect(model.reconcile('owner', recovery)).rejects.toThrow();
    expect((await pool.query('SELECT actor_id FROM bot_delivery_audits')).rows).toEqual([
      { actor_id: 'owner' },
    ]);
  });
  it('restores durable polling cursors across model instances', async () => {
    await model.saveCursor('wechat:bot-1', 'cursor-1');
    expect(await otherWorker.getCursor('wechat:bot-1')).toBe('cursor-1');
    expect(await otherWorker.getCursor('wechat:bot-2')).toBeUndefined();
  });
  it('grants one startup session and allows separate users and installations', async () => {
    const owners = await Promise.all([
      model.acquireSession('owner', 'scope'),
      otherWorker.acquireSession('owner', 'scope'),
    ]);
    expect(owners.filter(Boolean)).toHaveLength(1);
    expect(await otherWorker.acquireSession('other', 'scope')).toBeNull();
    expect(await otherWorker.acquireSession('other', 'other-scope')).toBeTruthy();
    expect(await model.acquireSession('owner', 'second-installation')).toBeTruthy();
  });
  it('propagates startup stop across workers and fences stale releases', async () => {
    const owner = (await model.acquireSession('owner', 'scope'))!;
    await otherWorker.requestStop('owner', 'scope');
    expect(await model.attachOperation('owner', 'scope', owner, 'op-1')).toEqual({
      stopRequested: 1,
    });
    await otherWorker.releaseSession('owner', 'scope', { operationId: 'stale-op' });
    expect((await model.getSession('owner', 'scope'))?.operationId).toBe('op-1');
    await otherWorker.releaseSession('owner', 'scope', { operationId: 'op-1' });
    expect(await model.getSession('owner', 'scope')).toBeNull();
  });
  it('reclaims expired startup but never blindly steals a known running operation', async () => {
    const stale = (await model.acquireSession('owner', 'scope'))!;
    await pool.query(
      "UPDATE bot_execution_sessions SET lease_expires_at = now() - interval '1 second'",
    );
    const owner = (await otherWorker.acquireSession('owner', 'scope'))!;
    expect(owner).not.toBe(stale);
    expect(await model.attachOperation('owner', 'scope', stale, 'stale-op')).toBeUndefined();
    await model.releaseSession('owner', 'scope', { owner: stale });
    await otherWorker.attachOperation('owner', 'scope', owner, 'running-op');
    await pool.query(
      "UPDATE bot_execution_sessions SET lease_expires_at = now() - interval '1 second'",
    );
    expect(await model.acquireSession('owner', 'scope')).toBeNull();
    expect((await model.getSession('owner', 'scope'))?.operationId).toBe('running-op');
  });
  it('recovers only sessions whose owning operation is durably terminal', async () => {
    for (const [key, status, userId] of [
      ['live', 'running', 'owner'],
      ['done', 'done', 'owner'],
      ['paused', 'waiting_for_human', 'owner'],
      ['foreign', 'done', 'other'],
    ]) {
      const owner = (await model.acquireSession('owner', key))!;
      await model.attachOperation('owner', key, owner, key);
      await pool.query('INSERT INTO agent_operations VALUES ($1, $2, $3)', [key, userId, status]);
    }
    await pool.query(
      "UPDATE bot_execution_sessions SET lease_expires_at = now() - interval '1 second'",
    );
    expect(await model.recoverTerminalSessions()).toBe(1);
    expect(await model.getSession('owner', 'done')).toBeNull();
    for (const key of ['live', 'paused', 'foreign'])
      expect(await model.getSession('owner', key)).toBeTruthy();
  });
});
