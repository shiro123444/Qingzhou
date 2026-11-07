import { AsyncLocalStorage } from 'node:async_hooks';

import type { Chat, Message, MessageContext, Thread } from 'chat';

import type { BotPlatformRuntimeContext } from './platforms/types';

/** Only throw before dispatch, or after a definitive platform rejection. */
export class ReplyUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'reply_budget_exhausted'
      | 'reply_window_expired'
      | 'reply_context_missing'
      | 'reply_budget_unavailable'
      | 'platform_rejected',
  ) {
    super(reason);
  }
}

type ReplyContext = Pick<
  BotPlatformRuntimeContext,
  'replyToMessageId' | 'replyToMessageReceivedAt'
> & { threadId: string };
export const channelReplyContext = new AsyncLocalStorage<ReplyContext>();

// Capture at handler invocation: debounced SDK dispatches may outlive adapter ingress.
export function withChannelReplyContext(handler: Parameters<Chat['onNewMention']>[0]) {
  return (thread: Thread, message: Message, context?: MessageContext) => {
    const date = message.metadata?.dateSent;
    return channelReplyContext.run(
      {
        threadId: thread.id,
        replyToMessageId: message.id,
        replyToMessageReceivedAt: date instanceof Date ? date.getTime() : undefined,
      },
      () => handler(thread, message, context),
    );
  };
}

/** All QQ visible sends consume the same atomic counter, including SDK command replies. */
export async function allocateQQReply(
  applicationId: string,
  threadId: string,
  context: BotPlatformRuntimeContext,
) {
  const type = threadId.split(':')[1];
  const active = channelReplyContext.getStore();
  const reply = context.replyToMessageId
    ? context
    : active?.threadId === threadId
      ? active
      : context;
  const msgId = reply.replyToMessageId;
  if (!msgId) {
    if (type === 'c2c' || type === 'group')
      throw new ReplyUnavailableError('reply_context_missing');
    return undefined;
  }
  const receivedAt = reply.replyToMessageReceivedAt;
  const windowMs = (type === 'c2c' ? 60 : 5) * 60_000;
  const assertReplyWindow = () => {
    const now = Date.now();
    if (
      typeof receivedAt !== 'number' ||
      !Number.isFinite(receivedAt) ||
      receivedAt > now ||
      now - receivedAt >= windowMs
    )
      throw new ReplyUnavailableError('reply_window_expired');
  };
  assertReplyWindow();
  const redis = context.redisClient;
  if (!redis?.incr || !redis.expire) throw new ReplyUnavailableError('reply_budget_unavailable');
  let msgSeq: number;
  try {
    const key = `qq:reply-seq:${applicationId}:${threadId}:${msgId}`;
    // INCR never reuses a slot, even if sending or setting expiry fails afterwards.
    msgSeq = await redis.incr(key);
    await redis.expire(key, 86_400);
  } catch {
    throw new ReplyUnavailableError('reply_budget_unavailable');
  }
  if (!Number.isSafeInteger(msgSeq) || msgSeq < 1)
    throw new ReplyUnavailableError('reply_budget_unavailable');
  const limit = type === 'c2c' ? 4 : type === 'group' ? 5 : Infinity;
  if (msgSeq > limit) throw new ReplyUnavailableError('reply_budget_exhausted');
  // Redis may have waited across the deadline. Keep the reserved sequence, but do not dispatch.
  assertReplyWindow();
  return { msgId, msgSeq };
}
