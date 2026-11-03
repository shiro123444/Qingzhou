import type { ChatTopicBotContext } from '@lobechat/types';

import type { LobeChatDatabase } from '@/database/type';

import { ChannelIdentityService, supportsChannelIdentity } from './channelIdentity';
import type { PlatformMessenger } from './platforms/types';

type IdentityContext = Pick<
  ChatTopicBotContext,
  'applicationId' | 'messengerInstallationKey' | 'platform' | 'senderExternalUserId'
>;

/** Recheck the current binding at the boundary of a new external action. */
export async function assertChannelIdentityAccess(
  db: LobeChatDatabase,
  userId: string | undefined,
  context?: IdentityContext,
  botAgentId?: string,
): Promise<void> {
  if (!context || context.messengerInstallationKey || !supportsChannelIdentity(context.platform))
    return;
  const access = await ChannelIdentityService.resolveAccess(
    db,
    context.platform,
    context.applicationId,
    context.senderExternalUserId,
    userId ? { userId, agentId: botAgentId } : undefined,
  );
  if (access.enforced && (!access.allowed || !userId || !context.senderExternalUserId))
    throw new Error('Channel identity no longer authorizes this action');
}

/** Each chunk and the user-visible file commit must pass the current binding. */
export function guardChannelMessenger(
  messenger: PlatformMessenger,
  assertAccess: () => Promise<void>,
): PlatformMessenger {
  return {
    ...messenger,
    createMessage: async (content) => {
      await assertAccess();
      return messenger.createMessage(content);
    },
    editMessage: async (messageId, content) => {
      await assertAccess();
      return messenger.editMessage(messageId, content);
    },
    createReplyCard: messenger.createReplyCard
      ? async (card) => {
          await assertAccess();
          return messenger.createReplyCard!(card);
        }
      : undefined,
    prepareReplyStream: messenger.prepareReplyStream
      ? async () => {
          await assertAccess();
          return messenger.prepareReplyStream!();
        }
      : undefined,
    sendReplyStreamFrame: messenger.sendReplyStreamFrame
      ? async (frame) => {
          await assertAccess();
          return messenger.sendReplyStreamFrame!(frame);
        }
      : undefined,
    prepareFile: messenger.prepareFile
      ? async (file) => {
          await assertAccess();
          const send = await messenger.prepareFile!(file);
          return async () => {
            await assertAccess();
            await send();
          };
        }
      : undefined,
    updateThreadName: messenger.updateThreadName
      ? async (name) => {
          await assertAccess();
          return messenger.updateThreadName!(name);
        }
      : undefined,
  };
}
