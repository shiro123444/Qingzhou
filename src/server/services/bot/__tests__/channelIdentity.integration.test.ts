// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelIdentityService } from '../channelIdentity';
import { claimIdentityChallenge, releaseIdentityChallenge } from '../channelIdentityStore';

const connectionString = process.env.CHANNEL_TEST_DATABASE_URL;
const redisUrl = process.env.CHANNEL_TEST_REDIS_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/qingzhou_channel_test'
  )
    throw new Error('Identity tests require a dedicated local qingzhou_channel_test database');
}
if (redisUrl) {
  const url = new URL(redisUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/15' ||
    !url.port ||
    url.port === '6379'
  )
    throw new Error('Identity tests require a dedicated local Redis port and database 15');
}
const { runtimeRedis } = vi.hoisted(() => ({ runtimeRedis: { current: null as Redis | null } }));
vi.mock('@/server/modules/AgentRuntime/redis', () => ({
  getAgentRuntimeRedisClient: () => runtimeRedis.current,
}));

describe.skipIf(!connectionString || !redisUrl)(
  'channel identity with real PostgreSQL and Redis',
  () => {
    const namespace = `identity_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${namespace}` });
    const db = drizzle(pool) as unknown as LobeChatDatabase;
    const service = new ChannelIdentityService(db, 'owner');
    const providerIds = new Set<string>();
    let redis: Redis;
    let providerId: string;

    beforeAll(async () => {
      redis = new Redis(redisUrl!, { maxRetriesPerRequest: 0 });
      runtimeRedis.current = redis;
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      await pool.query(`
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE agents (id text PRIMARY KEY);
      CREATE TABLE agent_bot_providers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id text NOT NULL REFERENCES agents(id),
        user_id text NOT NULL REFERENCES users(id), platform varchar(50) NOT NULL,
        application_id varchar(255) NOT NULL, credentials text, settings jsonb DEFAULT '{}',
        enabled boolean NOT NULL DEFAULT true, accessed_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(platform, application_id)
      );
      CREATE TABLE messenger_account_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES users(id),
        platform varchar(50) NOT NULL, tenant_id varchar(255) NOT NULL DEFAULT '',
        platform_user_id varchar(255) NOT NULL, platform_username text,
        active_agent_id text REFERENCES agents(id), accessed_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT messenger_account_links_platform_tenant_user_unique UNIQUE(platform, tenant_id, platform_user_id),
        CONSTRAINT messenger_account_links_user_platform_tenant_unique UNIQUE(user_id, platform, tenant_id)
      );
    `);
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE messenger_account_links, agent_bot_providers, agents, users CASCADE',
      );
      await pool.query(
        "INSERT INTO users VALUES ('owner'), ('other'); INSERT INTO agents VALUES ('agent'), ('other-agent')",
      );
      providerId = randomUUID();
      providerIds.add(providerId);
      await pool.query(
        "INSERT INTO agent_bot_providers(id, agent_id, user_id, platform, application_id, settings) VALUES ($1, 'agent', 'owner', 'wechat', 'app', $2)",
        [providerId, { allowFrom: ['existing'], otherSetting: 'preserved' }],
      );
    });
    afterEach(async () => {
      for (const id of providerIds) {
        const keys = await redis.keys(`bot:identity:{${id}}:*`);
        if (keys.length) await redis.del(...keys);
      }
      providerIds.clear();
    });
    afterAll(async () => {
      runtimeRedis.current = null;
      await redis?.quit();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.end();
    });

    it('binds the proven sender, enables protection and resolves the same Qingzhou owner', async () => {
      const challenge = await service.createChallenge(providerId);
      expect(challenge.command).toBe(`/bind ${challenge.code}`);
      expect(challenge.expiresAt - Date.now()).toBeGreaterThan(290_000);
      await service.completeChallenge(providerId, challenge.code, 'verified-sender', 'My WeChat');
      const state = await service.list(providerId);
      expect(state.permissions.requireBinding).toBe(true);
      expect(state.identities).toHaveLength(1);
      expect(state.identities[0].platformUserId).toBe('verified-sender');
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'app', 'verified-sender', {
          userId: 'owner',
          agentId: 'agent',
        }),
      ).toMatchObject({ enforced: true, allowed: true, operatorUserId: 'verified-sender' });
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'app', 'stranger'),
      ).toMatchObject({ enforced: true, allowed: false });
      const row = (
        await pool.query('SELECT settings FROM agent_bot_providers WHERE id=$1', [providerId])
      ).rows[0];
      expect(row.settings).toMatchObject({ otherSetting: 'preserved', allowFrom: ['existing'] });
    });

    it('allows only one sender to consume a code and rejects replay', async () => {
      const { code } = await service.createChallenge(providerId);
      const results = await Promise.allSettled([
        service.completeChallenge(providerId, code, 'sender-a'),
        service.completeChallenge(providerId, code, 'sender-b'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((await service.list(providerId)).identities).toHaveLength(1);
      await expect(service.completeChallenge(providerId, code, 'sender-c')).rejects.toThrow();
    });

    it('invalidates an already claimed old code after generating its replacement', async () => {
      const first = await service.createChallenge(providerId);
      const claim = await claimIdentityChallenge(redis, providerId, first.code, 'sender');
      const second = await service.createChallenge(providerId);
      await releaseIdentityChallenge(redis, providerId, claim, false);
      await expect(service.completeChallenge(providerId, first.code, 'sender')).rejects.toThrow();
      await service.completeChallenge(providerId, second.code, 'sender');
    });

    it('rejects a code after its target application changes', async () => {
      const { code } = await service.createChallenge(providerId);
      await pool.query("UPDATE agent_bot_providers SET application_id='new-app' WHERE id=$1", [
        providerId,
      ]);
      await expect(service.completeChallenge(providerId, code, 'sender')).rejects.toThrow(
        'invalid or expired',
      );
      expect((await service.list(providerId)).identities).toHaveLength(0);
    });

    it('requires fresh proof when an already-bound provider changes applications', async () => {
      const { code } = await service.createChallenge(providerId);
      await service.completeChallenge(providerId, code, 'sender');
      await pool.query("UPDATE agent_bot_providers SET application_id='new-app' WHERE id=$1", [
        providerId,
      ]);
      expect((await service.list(providerId)).identities).toHaveLength(0);
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'new-app', 'sender'),
      ).toMatchObject({ enforced: true, allowed: false });
      const replacement = await service.createChallenge(providerId);
      await service.completeChallenge(providerId, replacement.code, 'sender');
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'new-app', 'sender'),
      ).toMatchObject({ enforced: true, allowed: true });
    });

    it('rejects an expired code and limits code generation', async () => {
      const { code } = await service.createChallenge(providerId);
      await redis.pexpire(`bot:identity:{${providerId}}:code:${code}`, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(service.completeChallenge(providerId, code, 'sender')).rejects.toThrow();
      for (let count = 0; count < 4; count++) await service.createChallenge(providerId);
      await expect(service.createChallenge(providerId)).rejects.toThrow('Too many');
    });

    it('revokes immediately and invalidates a code created before revocation', async () => {
      const first = await service.createChallenge(providerId);
      await service.completeChallenge(providerId, first.code, 'sender');
      const pending = await service.createChallenge(providerId);
      const link = (await service.list(providerId)).identities[0];
      await service.revoke(providerId, link.id);
      expect((await service.list(providerId)).permissions.requireBinding).toBe(true);
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'app', 'sender'),
      ).toMatchObject({ enforced: true, allowed: false });
      await expect(service.completeChallenge(providerId, pending.code, 'sender')).rejects.toThrow(
        'invalid or expired',
      );
    });

    it('rejects another Qingzhou user listing, generating, changing or revoking a bot identity', async () => {
      const { code } = await service.createChallenge(providerId);
      await service.completeChallenge(providerId, code, 'sender');
      const link = (await service.list(providerId)).identities[0];
      const other = new ChannelIdentityService(db, 'other');
      await expect(other.list(providerId)).rejects.toThrow();
      await expect(other.createChallenge(providerId)).rejects.toThrow();
      await expect(other.revoke(providerId, link.id)).rejects.toThrow();
      await expect(other.updatePermissions(providerId, false)).rejects.toThrow();
      expect((await service.list(providerId)).identities).toHaveLength(1);
    });

    it('invalidates pending proof when permissions change and preserves explicit legacy policy', async () => {
      const { code } = await service.createChallenge(providerId);
      await service.updatePermissions(providerId, false);
      await expect(service.completeChallenge(providerId, code, 'sender')).rejects.toThrow(
        'invalid or expired',
      );
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'app', 'stranger'),
      ).toMatchObject({ enforced: false, allowed: true });
    });

    it('refuses a cached execution owner or agent after a bot is transferred', async () => {
      await pool.query(
        "UPDATE agent_bot_providers SET user_id='other', agent_id='other-agent' WHERE id=$1",
        [providerId],
      );
      expect(
        await ChannelIdentityService.resolveAccess(db, 'wechat', 'app', 'sender', {
          userId: 'owner',
          agentId: 'agent',
        }),
      ).toMatchObject({ enforced: true, allowed: false });
    });

    it('rolls back a failed identity persistence and lets the same code retry', async () => {
      const { code } = await service.createChallenge(providerId);
      await pool.query(`CREATE FUNCTION reject_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected persistence failure'; END $$;
      CREATE TRIGGER fail_identity BEFORE INSERT ON messenger_account_links FOR EACH ROW EXECUTE FUNCTION reject_identity()`);
      await expect(service.completeChallenge(providerId, code, 'sender')).rejects.toThrow();
      expect((await service.list(providerId)).permissions.requireBinding).toBe(false);
      await pool.query(
        'DROP TRIGGER fail_identity ON messenger_account_links; DROP FUNCTION reject_identity()',
      );
      await service.completeChallenge(providerId, code, 'sender');
      expect((await service.list(providerId)).identities).toHaveLength(1);
    });
  },
);
