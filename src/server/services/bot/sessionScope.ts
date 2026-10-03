import type { ChatTopicBotContext } from '@lobechat/types';

import { callbackHash } from './callbackLedger';

export function botSessionKey(
  userId: string,
  context: Pick<
    ChatTopicBotContext,
    'applicationId' | 'platform' | 'platformThreadId' | 'messengerInstallationKey'
  >,
) {
  return callbackHash([
    userId,
    context.platform,
    context.messengerInstallationKey
      ? ['installation', context.messengerInstallationKey]
      : ['application', context.applicationId],
    context.platformThreadId,
    userId,
  ]);
}
