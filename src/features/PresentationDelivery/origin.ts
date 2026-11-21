import { SESSION_CHAT_TOPIC_URL } from '@/const/url';

import type { PresentationJob } from '../../../packages/runtime-contracts/src/index';

export type PresentationChatOrigin = NonNullable<PresentationJob['chatOrigin']>;

export const presentationChatHref = (origin: Pick<PresentationChatOrigin, 'agentId' | 'topicId'>) =>
  SESSION_CHAT_TOPIC_URL(origin.agentId, origin.topicId);

export const presentationCreatorHref = (agentId: string, topicId?: string | null) => {
  const query = new URLSearchParams({ chatAgentId: agentId });
  if (topicId) query.set('chatTopicId', topicId);
  return `/presentation?${query}`;
};
