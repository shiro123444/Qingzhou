// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertChannelIdentityAccess, guardChannelMessenger } from '../channelIdentityAccess';

const resolveAccess = vi.hoisted(() => vi.fn());
vi.mock('../channelIdentity', () => ({
  ChannelIdentityService: { resolveAccess },
  supportsChannelIdentity: (platform: string) =>
    ['wechat', 'qq', 'feishu', 'lark'].includes(platform),
}));

const db = {} as any;
const context = { applicationId: 'app', platform: 'wechat', senderExternalUserId: 'sender' };
const allowed = { enforced: true, allowed: true, operatorUserId: 'sender' };
const revoked = { enforced: true, allowed: false, operatorUserId: undefined };

describe('channel identity at external action boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAccess.mockResolvedValue(allowed);
  });

  it('checks the current sender and owner before every protected action', async () => {
    await assertChannelIdentityAccess(db, 'owner', context);
    expect(resolveAccess).toHaveBeenCalledWith(db, 'wechat', 'app', 'sender', {
      userId: 'owner',
      agentId: undefined,
    });
    resolveAccess.mockResolvedValue(revoked);
    await expect(assertChannelIdentityAccess(db, 'owner', context)).rejects.toThrow(
      'no longer authorizes',
    );
  });

  it('blocks legacy protected callbacks without a sender or account identity', async () => {
    await expect(
      assertChannelIdentityAccess(db, 'owner', { ...context, senderExternalUserId: '' }),
    ).rejects.toThrow('no longer authorizes');
    await expect(assertChannelIdentityAccess(db, undefined, context)).rejects.toThrow(
      'no longer authorizes',
    );
  });

  it('keeps shared Messenger, other platforms and first-party execution on their existing path', async () => {
    resolveAccess.mockRejectedValue(new Error('must not query'));
    await assertChannelIdentityAccess(db, 'owner', {
      ...context,
      messengerInstallationKey: 'wechat:shared',
    });
    await assertChannelIdentityAccess(db, 'owner', { ...context, platform: 'slack' });
    await assertChannelIdentityAccess(db, 'owner');
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it('continues honoring legacy bot policy until binding protection is enabled', async () => {
    resolveAccess.mockResolvedValue({ enforced: false, allowed: true });
    await expect(
      assertChannelIdentityAccess(db, undefined, { ...context, senderExternalUserId: '' }),
    ).resolves.toBeUndefined();
  });

  it('stops later message chunks and edits after binding revocation', async () => {
    const createMessage = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const messenger = guardChannelMessenger(
      { createMessage, editMessage, removeReaction: vi.fn() },
      () => assertChannelIdentityAccess(db, 'owner', context),
    );
    await messenger.createMessage('first chunk');
    resolveAccess.mockResolvedValue(revoked);
    await expect(messenger.createMessage('private second chunk')).rejects.toThrow(
      'no longer authorizes',
    );
    await expect(messenger.editMessage('message', 'private result')).rejects.toThrow(
      'no longer authorizes',
    );
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('rechecks a prepared file before its visible delivery after revocation', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const prepareFile = vi.fn().mockResolvedValue(send);
    const messenger = guardChannelMessenger(
      {
        createMessage: vi.fn(),
        editMessage: vi.fn(),
        removeReaction: vi.fn(),
        prepareFile,
      },
      () => assertChannelIdentityAccess(db, 'owner', context),
    );
    const commit = await messenger.prepareFile!({
      bytes: Buffer.from('private'),
      deliveryId: 'file',
      filename: 'result.pdf',
      mimeType: 'application/pdf',
    });
    resolveAccess.mockResolvedValue(revoked);
    await expect(commit()).rejects.toThrow('no longer authorizes');
    expect(prepareFile).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks native cards and stream frames after a reply is prepared', async () => {
    const createReplyCard = vi.fn();
    const sendReplyStreamFrame = vi.fn();
    const prepareReplyStream = vi.fn().mockResolvedValue({ msgSeq: 1, replyMessageId: 'incoming' });
    const messenger = guardChannelMessenger(
      {
        createMessage: vi.fn(),
        editMessage: vi.fn(),
        removeReaction: vi.fn(),
        createReplyCard,
        prepareReplyStream,
        sendReplyStreamFrame,
      },
      () => assertChannelIdentityAccess(db, 'owner', context),
    );
    await messenger.prepareReplyStream!();
    resolveAccess.mockResolvedValue(revoked);
    await expect(
      messenger.createReplyCard!({ title: 'result', content: 'private', deliveryId: 'card' }),
    ).rejects.toThrow('no longer authorizes');
    await expect(
      messenger.sendReplyStreamFrame!({
        content: 'private',
        final: true,
        index: 0,
        msgSeq: 1,
        replyMessageId: 'incoming',
      }),
    ).rejects.toThrow('no longer authorizes');
    expect(createReplyCard).not.toHaveBeenCalled();
    expect(sendReplyStreamFrame).not.toHaveBeenCalled();
  });
});
