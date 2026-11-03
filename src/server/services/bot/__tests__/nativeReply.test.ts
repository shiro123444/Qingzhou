// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallbackDeliverySession, InMemoryCallbackLedger } from '../callbackLedger';
import { deliverNativeReply } from '../nativeReply';
import type { PlatformMessenger, ReplyCard, ReplyStreamFrame } from '../platforms/types';

vi.mock('@/server/modules/AgentRuntime/redis', () => ({ getAgentRuntimeRedisClient: vi.fn() }));
vi.mock('@/server/services/queue/impls', () => ({ isQueueAgentRuntimeEnabled: vi.fn() }));

const body = {
  applicationId: 'app',
  operationId: 'operation',
  platformThreadId: 'qq:c2c:sender',
  userId: 'owner',
  stepIndex: 1,
  type: 'step' as const,
};

describe('durable native replies', () => {
  let ledger: InMemoryCallbackLedger;
  const sessions: CallbackDeliverySession[] = [];
  const messenger = (): PlatformMessenger => ({
    createMessage: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
  });
  const begin = async (stepIndex = 1, type: 'step' | 'completion' = 'step') => {
    const session = (await CallbackDeliverySession.begin(
      { ...body, stepIndex, type },
      `${type}-${stepIndex}`,
      ledger,
    ))!;
    sessions.push(session);
    return session;
  };
  const deliver = (
    delivery: CallbackDeliverySession,
    target: PlatformMessenger,
    overrides: Partial<Parameters<typeof deliverNativeReply>[0]> = {},
  ) =>
    deliverNativeReply({
      content: 'answer',
      delivery,
      deliveryId: 'delivery',
      final: false,
      messenger: target,
      title: 'Progress',
      ...overrides,
    });

  beforeEach(() => {
    ledger = new InMemoryCallbackLedger();
  });
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.release()));
  });

  it('leaves the existing text path available when native capabilities are absent', async () => {
    const session = await begin();
    const target = messenger();
    expect(await deliver(session, target)).toBeUndefined();
    expect(target.createMessage).not.toHaveBeenCalled();
    expect(session.frozenPlan()).toBeUndefined();
  });

  it('keeps a partially delivered text event on its frozen text path after cards are enabled', async () => {
    const session = await begin();
    await session.plan({ chunks: ['original text'], canEdit: false });
    await session.effect('chunk:0', async () => {});
    const target = { ...messenger(), createReplyCard: vi.fn() };
    expect(await deliver(session, target)).toBeUndefined();
    expect(target.createReplyCard).not.toHaveBeenCalled();
  });

  it('freezes native card content and attaches approval buttons only to the last chunk', async () => {
    const session = await begin();
    const createReplyCard = vi.fn().mockResolvedValue(undefined);
    const target = { ...messenger(), createReplyCard };
    const actions: ReplyCard['actions'] = [
      {
        action: 'confirm',
        label: 'Confirm',
        platformThreadId: 'feishu:p2p:chat',
        token: '0123456789ab',
      },
    ];
    const content = 'Long answer '.repeat(400);
    expect(await deliver(session, target, { actions, artifacts: ['file-id'], content })).toEqual({
      artifacts: ['file-id'],
    });
    const cards = createReplyCard.mock.calls.map(([card]) => card as ReplyCard);
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.slice(0, -1).every((card) => card.actions === undefined)).toBe(true);
    expect(cards.at(-1)?.actions).toEqual(actions);
    expect(new Set(cards.map((card) => card.deliveryId)).size).toBe(cards.length);
    await session.release();

    const resumed = await begin();
    expect(await deliver(resumed, target, { content: 'changed content', artifacts: [] })).toEqual({
      artifacts: ['file-id'],
    });
    expect(createReplyCard).toHaveBeenCalledTimes(cards.length);
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('refuses to replace a frozen native card with text when its capability disappears', async () => {
    const session = await begin();
    await deliver(session, {
      ...messenger(),
      createReplyCard: vi.fn().mockResolvedValue(undefined),
    });
    await session.release();
    const resumed = await begin();
    const target = messenger();
    await expect(deliver(resumed, target)).rejects.toThrow('unavailable');
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('quarantines an ambiguous native card result without emitting a text fallback', async () => {
    const session = await begin();
    const createReplyCard = vi.fn().mockRejectedValue(new Error('response lost'));
    const target = { ...messenger(), createReplyCard };
    await expect(deliver(session, target)).rejects.toMatchObject({ status: 'unknown_delivery' });
    await session.release();
    await expect(begin()).rejects.toMatchObject({ status: 'unknown_delivery' });
    expect(createReplyCard).toHaveBeenCalledTimes(1);
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('preserves a replace-mode prefix and one stream identity across steps and the final reply', async () => {
    const frames: ReplyStreamFrame[] = [];
    const prepareReplyStream = vi
      .fn()
      .mockResolvedValue({ msgSeq: 7, replyMessageId: 'inbound-message' });
    const sendReplyStreamFrame = vi.fn(async (frame: ReplyStreamFrame) => {
      frames.push(structuredClone(frame));
      return { streamId: 'stream-id' };
    });
    const target = { ...messenger(), prepareReplyStream, sendReplyStreamFrame };
    const first = await begin();
    await deliver(first, target, { content: 'First step' });
    await first.complete();
    await first.release();
    const second = await begin(2);
    await deliver(second, target, { content: 'Second step' });
    await second.complete();
    await second.release();
    const final = await begin(3, 'completion');
    await deliver(final, target, { content: 'Final answer', final: true });

    expect(prepareReplyStream).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.index)).toEqual([0, 1, 2]);
    expect(frames.map((frame) => frame.final)).toEqual([false, false, true]);
    expect(frames[1].content.startsWith(frames[0].content)).toBe(true);
    expect(frames[2].content.startsWith(frames[1].content)).toBe(true);
    expect(frames[2].content).toContain('Final answer');
    expect(
      frames.every((frame) => frame.msgSeq === 7 && frame.replyMessageId === 'inbound-message'),
    ).toBe(true);
    expect(frames.slice(1).every((frame) => frame.streamId === 'stream-id')).toBe(true);
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('blocks further stream sends after an unknown frame result', async () => {
    const session = await begin();
    const sendReplyStreamFrame = vi.fn().mockRejectedValue(new Error('frame response lost'));
    const target = {
      ...messenger(),
      prepareReplyStream: vi.fn().mockResolvedValue({ msgSeq: 1, replyMessageId: 'message' }),
      sendReplyStreamFrame,
    };
    await expect(deliver(session, target)).rejects.toMatchObject({ status: 'unknown_delivery' });
    await session.release();
    await expect(begin(2)).rejects.toMatchObject({ status: 'unknown_delivery' });
    expect(sendReplyStreamFrame).toHaveBeenCalledTimes(1);
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('leaves an oversized first final reply on the ordinary text path', async () => {
    const session = await begin(1, 'completion');
    const target = {
      ...messenger(),
      prepareReplyStream: vi.fn(),
      sendReplyStreamFrame: vi.fn(),
    };
    expect(
      await deliver(session, target, { content: 'long first answer', charLimit: 5, final: true }),
    ).toBeUndefined();
    expect(target.prepareReplyStream).not.toHaveBeenCalled();
    expect(target.sendReplyStreamFrame).not.toHaveBeenCalled();
    expect(session.frozenPlan()).toBeUndefined();
  });

  it('skips over-budget progress and closes the existing prefix before sending final fallback text', async () => {
    const calls: string[] = [];
    const frames: ReplyStreamFrame[] = [];
    const target = {
      ...messenger(),
      createMessage: vi.fn(async () => {
        calls.push('text');
      }),
      prepareReplyStream: vi.fn().mockResolvedValue({ msgSeq: 1, replyMessageId: 'message' }),
      sendReplyStreamFrame: vi.fn(async (frame: ReplyStreamFrame) => {
        frames.push(structuredClone(frame));
        calls.push(frame.final ? 'close' : 'stream');
        return { streamId: 'stream', remainingCharacters: 0 };
      }),
    };
    const first = await begin();
    await deliver(first, target, { content: 'hello', charLimit: 12 });
    await first.complete();
    await first.release();
    const oversized = await begin(2);
    expect(await deliver(oversized, target, { content: 'over the budget', charLimit: 12 })).toEqual(
      { artifacts: [] },
    );
    expect(oversized.frozenPlan()).toBeUndefined();
    await oversized.complete();
    await oversized.release();
    const final = await begin(3, 'completion');
    await deliver(final, target, {
      content: 'large final content',
      fallbackText: 'Final',
      charLimit: 12,
      final: true,
    });
    expect(calls).toEqual(['stream', 'close', 'text']);
    expect(frames[1]).toMatchObject({
      content: 'hello',
      final: true,
      index: 1,
      streamId: 'stream',
    });
    expect(target.createMessage).toHaveBeenCalledWith('Final');
    expect(target.prepareReplyStream).toHaveBeenCalledTimes(1);
  });

  it('blocks fallback text when closing an over-budget stream has an unknown outcome', async () => {
    const sendReplyStreamFrame = vi
      .fn()
      .mockResolvedValueOnce({ streamId: 'stream' })
      .mockRejectedValueOnce(new Error('close response lost'));
    const target = {
      ...messenger(),
      prepareReplyStream: vi.fn().mockResolvedValue({ msgSeq: 1, replyMessageId: 'message' }),
      sendReplyStreamFrame,
    };
    const first = await begin();
    await deliver(first, target, { content: 'hello', charLimit: 12 });
    await first.complete();
    await first.release();
    const final = await begin(2, 'completion');
    await expect(
      deliver(final, target, {
        content: 'large final content',
        fallbackText: 'Final',
        charLimit: 12,
        final: true,
      }),
    ).rejects.toMatchObject({ status: 'unknown_delivery' });
    expect(target.createMessage).not.toHaveBeenCalled();
    expect(sendReplyStreamFrame).toHaveBeenCalledTimes(2);
  });

  it('rejects a late native update once the transport is already final', async () => {
    const target = {
      ...messenger(),
      prepareReplyStream: vi.fn().mockResolvedValue({ msgSeq: 1, replyMessageId: 'message' }),
      sendReplyStreamFrame: vi.fn().mockResolvedValue({ streamId: 'stream' }),
    };
    const first = await begin();
    await deliver(first, target, { final: true });
    await first.complete();
    await first.release();
    const late = await begin(2);
    await expect(deliver(late, target)).rejects.toThrow('already finished');
    expect(target.sendReplyStreamFrame).toHaveBeenCalledTimes(1);
    expect(target.createMessage).not.toHaveBeenCalled();
  });

  it('does not start a replacement stream after an earlier delivery lost its receipt', async () => {
    const first = await begin();
    await first.effect('qq-stream', async () => {});
    await first.complete();
    await first.release();
    const next = await begin(2);
    const target = { ...messenger(), prepareReplyStream: vi.fn(), sendReplyStreamFrame: vi.fn() };
    await expect(deliver(next, target)).rejects.toMatchObject({ status: 'payload_conflict' });
    expect(target.prepareReplyStream).not.toHaveBeenCalled();
    expect(target.sendReplyStreamFrame).not.toHaveBeenCalled();
  });
});
