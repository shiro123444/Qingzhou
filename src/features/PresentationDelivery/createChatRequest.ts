import { INBOX_SESSION_ID } from '@/const/session';
import { lambdaClient } from '@/libs/trpc/client';
import { agentService } from '@/services/agent';
import { messageService } from '@/services/message';
import { useChatStore } from '@/store/chat';

import type { PresentationChatOrigin } from './origin';

export const createChatRequest = async (
  title: string,
  content: string,
): Promise<PresentationChatOrigin> => {
  const query = new URLSearchParams(window.location.search);
  const agentId =
    query.get('chatAgentId') || (await agentService.getBuiltinAgent(INBOX_SESSION_ID))?.id;
  if (!agentId) throw new Error('Chat agent unavailable');
  const topicId =
    query.get('chatTopicId') || (await lambdaClient.topic.createTopic.mutate({ agentId, title }));
  const { id: messageId, messages } = await messageService.createMessage({
    agentId,
    topicId,
    content,
    role: 'user',
    metadata: { presentationRequest: true },
  });
  useChatStore
    .getState()
    .replaceMessages(messages, { context: { agentId, topicId, scope: 'main' } });
  return { agentId, topicId, messageId };
};
