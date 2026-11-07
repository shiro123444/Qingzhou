// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { CallbackDeliverySession, InMemoryCallbackLedger } from '../callbackLedger';
import {
  allocateQQReply,
  channelReplyContext,
  ReplyUnavailableError,
  withChannelReplyContext,
} from '../replyBudget';

const redisCounter = () => {
  const counts = new Map<string, number>();
  return {
    incr: vi.fn(async (key: string) => {
      const value = (counts.get(key) ?? 0) + 1;
      counts.set(key, value);
      return value;
    }),
    expire: vi.fn(async () => 1),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
};

describe('shared reply budgets', () => {
  it.each([
    ['c2c', 4],
    ['group', 5],
  ] as const)(
    'caps concurrent %s text, files and stream allocations across clients',
    async (type, cap) => {
      const context = {
        replyToMessageId: 'inbound',
        replyToMessageReceivedAt: Date.now(),
        redisClient: redisCounter(),
      };
      const replies = await Promise.allSettled(
        Array.from({ length: 12 }, () => allocateQQReply('app', `qq:${type}:user`, { ...context })),
      );
      expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(cap);
      expect(
        replies
          .filter((r) => r.status === 'rejected')
          .every((r) => r.reason.reason === 'reply_budget_exhausted'),
      ).toBe(true);
      expect(
        await allocateQQReply('app', `qq:${type}:user`, { ...context, replyToMessageId: 'new' }),
      ).toEqual({ msgId: 'new', msgSeq: 1 });
    },
  );

  it('rejects expired and missing context before consuming a slot', async () => {
    const redisClient = redisCounter();
    for (const [type, minutes] of [
      ['c2c', 60],
      ['group', 5],
    ] as const)
      await expect(
        allocateQQReply('app', `qq:${type}:user`, {
          redisClient,
          replyToMessageId: 'old',
          replyToMessageReceivedAt: Date.now() - minutes * 60_000,
        }),
      ).rejects.toThrow('reply_window_expired');
    await expect(allocateQQReply('app', 'qq:c2c:user', { redisClient })).rejects.toThrow(
      'reply_context_missing',
    );
    expect(redisClient.incr).not.toHaveBeenCalled();
  });

  it('isolates concurrent SDK reply contexts by incoming message and conversation', async () => {
    const redisClient = redisCounter();
    const handler = withChannelReplyContext(async (thread) => {
      await Promise.resolve();
      expect(channelReplyContext.getStore()?.threadId).toBe(thread.id);
      await expect(allocateQQReply('app', thread.id, { redisClient })).resolves.toMatchObject({
        msgSeq: 1,
      });
    });
    await Promise.all(
      ['one', 'two'].map((id) =>
        handler({ id: `qq:c2c:${id}` } as any, { id, metadata: { dateSent: new Date() } } as any),
      ),
    );
    expect(channelReplyContext.getStore()).toBeUndefined();
    expect(redisClient.incr.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        'qq:reply-seq:app:qq:c2c:one:one',
        'qq:reply-seq:app:qq:c2c:two:two',
      ]),
    );
  });

  it('does not dispatch when the reply window expires while allocating a sequence', async () => {
    const receivedAt = 1_000_000;
    let now = receivedAt + 5 * 60_000 - 1;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const redisClient = redisCounter();
    redisClient.expire.mockImplementation(async () => {
      now++;
      return 1;
    });
    try {
      await expect(
        allocateQQReply('app', 'qq:group:room', {
          redisClient,
          replyToMessageId: 'inbound',
          replyToMessageReceivedAt: receivedAt,
        }),
      ).rejects.toThrow('reply_window_expired');
      expect(redisClient.incr).toHaveBeenCalledTimes(1);
      expect(redisClient.del).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('removes only known-unsent markers, preserving confirmed effects and uncertain sends', async () => {
    const backend = new InMemoryCallbackLedger();
    const body = {
      type: 'completion' as const,
      userId: 'owner',
      operationId: 'op',
      applicationId: 'app',
      platformThreadId: 'qq:c2c:user',
    };
    const session = (await CallbackDeliverySession.begin(body, 'intent', backend))!;
    await session.plan({ text: 'result' });
    await session.effect('first', async () => {});
    await expect(
      session.effect('second', async () => {
        throw new ReplyUnavailableError('reply_budget_exhausted');
      }),
    ).rejects.toThrow('reply_budget_exhausted');
    await session.release();
    const retry = (await CallbackDeliverySession.begin(body, 'intent', backend))!;
    expect(retry.hasDeliveredEffect('first')).toBe(true);
    const send = vi.fn(async () => {
      throw new Error('timeout after dispatch');
    });
    await expect(retry.effect('second', send)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    await retry.release();
    await expect(CallbackDeliverySession.begin(body, 'intent', backend)).rejects.toMatchObject({
      status: 'unknown_delivery',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
