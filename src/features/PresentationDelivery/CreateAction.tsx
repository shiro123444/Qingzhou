import { Button } from '@lobehub/ui';
import { Presentation } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConversationStore } from '@/features/Conversation/store';

import { presentationCreatorHref } from './origin';

export default function CreateAction() {
  const { t } = useTranslation('common');
  const { agentId, topicId, threadId } = useConversationStore((s) => s.context);
  if (!agentId || threadId) return null;
  return (
    <Button
      href={presentationCreatorHref(agentId, topicId)}
      icon={Presentation}
      size="small"
      type="text"
    >
      {t('presentationDelivery.create')}
    </Button>
  );
}
