// @vitest-environment node
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelDigestModel } from '@/database/models/channelDigest';
import { createCallerFactory } from '@/libs/trpc/lambda';

import { channelRouter } from '../channel';

const { getServerDB, getStatus, getPlatform, resolveMode } = vi.hoisted(() => ({
  getServerDB: vi.fn(),
  getStatus: vi.fn(),
  getPlatform: vi.fn(),
  resolveMode: vi.fn(),
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB }));
vi.mock('@/server/services/gateway/runtimeStatus', () => ({ getBotRuntimeStatus: getStatus }));
vi.mock('@/server/services/bot/platforms', async () => {
  const actual = await import('@/server/services/bot/platforms/const');
  return {
    ...actual,
    platformRegistry: { getPlatform },
    resolveConnectionMode: resolveMode,
  };
});

const createCaller = createCallerFactory(channelRouter);
const dialect = new PgDialect();
const now = new Date('2026-11-03T01:00:00Z');
const provider = {
  agentId: 'agent-1',
  agentTitle: 'Research',
  applicationId: 'app-1',
  enabled: true,
  id: 'provider-1',
  platform: 'wechat',
  updatedAt: now,
  credentials: 'must-never-be-returned',
  settings: {
    allowFrom: [{ id: 'person', name: 'Owner', token: 'nested-secret' }],
    dmPolicy: 'pairing',
    groupPolicy: 'allowlist',
    groupAllowFrom: ['group-1'],
    channelIdentity: { requireBinding: true, challenge: 'secret-challenge' },
    botToken: 'secret-token',
    webhookUrl: 'https://secret.example/',
  },
};

function database(results: unknown[][]) {
  const selections: Array<Record<string, unknown>> = [];
  const predicates: unknown[] = [];
  const limits: number[] = [];
  const joins: unknown[] = [];
  const select = vi.fn((projection: Record<string, unknown>) => {
    selections.push(projection);
    const rows = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn((_table, condition) => {
        joins.push(condition);
        return builder;
      }),
      where: vi.fn((condition) => {
        predicates.push(condition);
        return builder;
      }),
      orderBy: vi.fn(() => builder),
      limit: vi.fn((limit: number) => {
        limits.push(limit);
        return builder;
      }),
      // Drizzle query builders are awaitable before .limit() is applied.
      // eslint-disable-next-line unicorn/no-thenable
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  });
  return { db: { select }, selections, predicates, limits, joins };
}

describe('channel management metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatform.mockReturnValue({ id: 'wechat' });
    resolveMode.mockReturnValue('polling');
    getStatus.mockResolvedValue({
      applicationId: 'app-1',
      platform: 'wechat',
      status: 'connected',
      updatedAt: 123,
      errorMessage: 'SDK error containing secret-token',
    });
  });

  it('requires a Qingzhou login before reading channel metadata', async () => {
    const caller = createCaller({});
    await expect(caller.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getServerDB).not.toHaveBeenCalled();
  });

  it('requires an owned installation and an observed group before enabling collection', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const input = {
      providerId: id,
      threadId: 'feishu:group:oc_test',
      scheduleTime: '18:00',
      enabled: true,
      sendToSource: false,
    };
    const save = vi.spyOn(ChannelDigestModel.prototype, 'save').mockResolvedValue();
    const caller = createCaller({ userId: 'owner' });
    getServerDB.mockResolvedValue(database([[]]).db);
    await expect(caller.saveDigest(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    getServerDB.mockResolvedValue(
      database([[{ ...provider, id, platform: 'feishu', settings: {} }], []]).db,
    );
    await expect(caller.saveDigest(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(save).not.toHaveBeenCalled();
    const observed = database([
      [{ ...provider, id, platform: 'feishu', settings: {} }],
      [{ id: 'event' }],
    ]);
    getServerDB.mockResolvedValue(observed.db);
    await caller.saveDigest(input);
    expect(dialect.sqlToQuery(observed.predicates[1] as any).params).toEqual([
      'owner',
      'feishu',
      'app-1',
      'feishu:group:oc_test',
    ]);
    expect(save).toHaveBeenCalledWith('owner', id, input);
    save.mockRestore();
  });

  it('rejects private sources, cross-platform sources and scheduled QQ delivery', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const input = {
      providerId: id,
      threadId: 'qq:group:g',
      scheduleTime: '18:00',
      enabled: true,
      sendToSource: true,
    };
    const caller = createCaller({ userId: 'owner' });
    getServerDB.mockResolvedValue(
      database([[{ ...provider, id, platform: 'qq', settings: {} }]]).db,
    );
    await expect(caller.saveDigest(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.saveDigest({ ...input, threadId: 'qq:c2c:person', sendToSource: false }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    getServerDB.mockResolvedValue(
      database([[{ ...provider, id, platform: 'qq', settings: {} }]]).db,
    );
    await expect(
      caller.saveDigest({ ...input, threadId: 'feishu:group:g', sendToSource: false }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('filters the authenticated owner and supported platforms in SQL without selecting credentials', async () => {
    const fixture = database([[provider]]);
    getServerDB.mockResolvedValue(fixture.db);
    const caller = createCaller({ userId: 'owner' });
    const result = await caller.list();
    expect(dialect.sqlToQuery(fixture.predicates[0] as any).params).toEqual([
      'owner',
      'wechat',
      'napcat',
      'qq',
      'feishu',
      'lark',
    ]);
    expect(dialect.sqlToQuery(fixture.joins[0] as any).params).toEqual(['owner']);
    expect(fixture.selections[0]).not.toHaveProperty('credentials');
    expect(result).toEqual([
      {
        agentId: 'agent-1',
        agentTitle: 'Research',
        applicationId: 'app-1',
        connectionMode: 'polling',
        enabled: true,
        id: 'provider-1',
        platform: 'wechat',
        updatedAt: now,
        runtimeStatus: {
          applicationId: 'app-1',
          platform: 'wechat',
          status: 'connected',
          updatedAt: 123,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result[0]).not.toHaveProperty('settings');
  });

  it('rejects another user provider without looking up its runtime or activity', async () => {
    const fixture = database([[]]);
    getServerDB.mockResolvedValue(fixture.db);
    const caller = createCaller({ userId: 'other-user' });
    await expect(caller.detail({ providerId: 'provider-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dialect.sqlToQuery(fixture.predicates[0] as any).params).toEqual([
      'other-user',
      'wechat',
      'napcat',
      'qq',
      'feishu',
      'lark',
      'provider-1',
    ]);
    expect(fixture.db.select).toHaveBeenCalledTimes(1);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('scopes recent inbound activity to the exact owner and installation and projects safe fields', async () => {
    const fixture = database([
      [provider],
      [
        {
          id: 'event-1',
          status: 'processed',
          attempts: 2,
          createdAt: now,
          updatedAt: now,
          payload: 'private message',
          threadId: 'private-target',
          errorCode: 'secret-error',
        },
      ],
    ]);
    getServerDB.mockResolvedValue(fixture.db);
    const caller = createCaller({ userId: 'owner' });
    const result = await caller.detail({ providerId: 'provider-1' });
    expect(dialect.sqlToQuery(fixture.predicates[1] as any).params).toEqual([
      'owner',
      'wechat',
      'app-1',
    ]);
    expect(fixture.limits).toEqual([30]);
    expect(fixture.selections[1]).not.toHaveProperty('payload');
    expect(fixture.selections[1]).not.toHaveProperty('threadId');
    expect(result.activity).toEqual([
      {
        attempts: 2,
        createdAt: now,
        direction: 'inbound',
        id: 'event-1',
        status: 'processed',
        updatedAt: now,
      },
    ]);
    expect(result.settings).toEqual({
      allowFrom: [{ id: 'person', name: 'Owner' }],
      channelIdentity: { requireBinding: true },
      dmPolicy: 'pairing',
      groupAllowFrom: [{ id: 'group-1' }],
      groupPolicy: 'allowlist',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('normalizes legacy access configuration and keeps unrelated settings private', async () => {
    const fixture = database([
      [
        {
          ...provider,
          settings: {
            allowFrom: 'alice, bob',
            groupAllowFrom: ['group-2'],
            dmPolicy: 'invalid',
            groupPolicy: 'disabled',
            userId: 'operator-private-id',
            apiKey: 'secret-key',
          },
        },
      ],
      [],
    ]);
    getServerDB.mockResolvedValue(fixture.db);
    const caller = createCaller({ userId: 'owner' });
    const result = await caller.detail({ providerId: 'provider-1' });
    expect(result.settings).toEqual({
      allowFrom: [{ id: 'alice' }, { id: 'bob' }],
      channelIdentity: { requireBinding: false },
      dmPolicy: 'open',
      groupAllowFrom: [{ id: 'group-2' }],
      groupPolicy: 'disabled',
    });
    expect(result.settings).not.toHaveProperty('userId');
  });
  it('does not query task content for a provider outside the authenticated owner', async () => {
    const fixture = database([[]]);
    getServerDB.mockResolvedValue(fixture.db);
    await expect(
      createCaller({ userId: 'owner' }).task({ providerId: 'other', taskId: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fixture.db.select).toHaveBeenCalledTimes(1);
    expect(dialect.sqlToQuery(fixture.predicates[0] as any).params).toContain('owner');
  });
  it('projects a task detail without sender identity or delivery secrets', async () => {
    const fixture = database([
      [provider],
      [
        {
          id: 'a'.repeat(64),
          createdAt: now,
          updatedAt: now,
          state: {
            channelTask: {
              agentId: 'agent-1',
              applicationId: 'app-1',
              platform: 'wechat',
              operationId: 'op',
              completed: true,
              content: 'answer',
              artifactIds: [],
              delivery: 'retained',
              reason: 'reply_context_missing',
              platformThreadId: 'private-thread',
              senderExternalUserId: 'private-sender',
            },
          },
        },
      ],
    ]);
    getServerDB.mockResolvedValue(fixture.db);
    const result = await createCaller({ userId: 'owner' }).task({
      providerId: 'provider-1',
      taskId: 'a'.repeat(64),
    });
    expect(result.content).toBe('answer');
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(dialect.sqlToQuery(fixture.predicates[1] as any).params).toEqual([
      'owner',
      'wechat',
      'app-1',
      'a'.repeat(64),
    ]);
  });
});
