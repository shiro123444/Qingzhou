// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ComputerStore } from './store';

describe.skipIf(!process.env.QINGZHOU_COMPUTER_POSTGRES_TEST_URL)(
  'real PostgreSQL Computer transactions',
  () => {
    let pool: Pool, db: LobeChatDatabase;
    const scope = { userId: randomUUID(), agentId: randomUUID() };
    const store = () => new ComputerStore(db, scope, 'postgres-test-binding');
    beforeAll(async () => {
      const url = new URL(process.env.QINGZHOU_COMPUTER_POSTGRES_TEST_URL!);
      if (url.hostname !== '127.0.0.1' || url.pathname !== '/qingzhou_accept_computer')
        throw new Error('ISOLATED_POSTGRES_REQUIRED');
      pool = new Pool({ connectionString: url.href, max: 4 });
      db = drizzle(pool) as LobeChatDatabase;
      await pool.query(
        'CREATE TABLE users(id text PRIMARY KEY); CREATE TABLE agents(id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id));',
      );
      // This fixture tests Computer row locks and recovery on real PostgreSQL. It does not claim a full application schema migration.
      for (const file of [
        '0117_agent_computer.sql',
        '0118_computer_receipt_recovery.sql',
        '0119_computer_browser.sql',
      ])
        await pool.query(await readFile(`packages/database/migrations/${file}`, 'utf8'));
      await pool.query('INSERT INTO users VALUES($1)', [scope.userId]);
      await pool.query('INSERT INTO agents VALUES($1,$2)', [scope.agentId, scope.userId]);
    });
    afterAll(async () => pool?.end());
    it('serializes concurrent initial claims and fences a foreign lease without duplicate work', async () => {
      const outcomes = await Promise.allSettled([
        store().claim({ kind: 'ensure' }, 'human', 'first', 0),
        store().claim({ kind: 'ensure' }, 'human', 'second', 0),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const selected = outcomes.find((result) => result.status === 'fulfilled')!;
      if (selected.status !== 'fulfilled' || !('lease' in selected.value))
        throw new Error('LEASE_NOT_ACQUIRED');
      const lease = selected.value.lease;
      await expect(store().dispatch({ ...lease, owner: randomUUID() })).rejects.toThrow(
        'OUTCOME_UNKNOWN',
      );
      await store().dispatch(lease);
      await store().finish(lease, {
        resourceId: 'postgres-owned-resource',
        state: 'ready',
        control: 'agent',
      });
      const count = await pool.query('SELECT count(*)::int AS count FROM agent_computer_sessions');
      expect(count.rows[0].count).toBe(1);
    });
    it('retains a dispatched unknown action across reconnect and never claims it for replay', async () => {
      const accepted = await store().claim(
        { kind: 'shell', command: 'write-once', timeoutMs: 30000 },
        'agent',
        'dispatched',
      );
      if (!('lease' in accepted)) throw new Error('LEASE_NOT_ACQUIRED');
      await store().dispatch(accepted.lease);
      await pool.query(
        "UPDATE agent_computer_sessions SET lease_until=clock_timestamp()-interval '1 second'",
      );
      await pool.end();
      pool = new Pool({
        connectionString: process.env.QINGZHOU_COMPUTER_POSTGRES_TEST_URL,
        max: 4,
      });
      db = drizzle(pool) as LobeChatDatabase;
      await store().recoverExpired();
      expect((await store().view()).session?.state).toBe('unknown');
      await expect(
        store().claim(
          { kind: 'shell', command: 'write-once', timeoutMs: 30000 },
          'agent',
          'new-id',
        ),
      ).rejects.toThrow('OUTCOME_UNKNOWN');
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM agent_computer_commands WHERE kind='shell'",
          )
        ).rows[0].count,
      ).toBe(1);
    });
  },
);
