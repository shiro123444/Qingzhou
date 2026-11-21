'use client';

import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { createChatRequest } from '@/features/PresentationDelivery/createChatRequest';
import {
  presentationChatHref,
  type PresentationChatOrigin,
} from '@/features/PresentationDelivery/origin';
import { messageService } from '@/services/message';
import { useChatStore } from '@/store/chat';

import PresentationStudio from './PresentationStudio';

export default function PresentationPage() {
  const navigate = useNavigate();
  const pending = useRef<{ key: string; request: Promise<PresentationChatOrigin> } | null>(null);
  return (
    <PresentationStudio
      prepareChatRequest={async (title, content) => {
        const key = JSON.stringify([window.location.search, title, content]);
        if (pending.current?.key !== key) {
          pending.current = { key, request: createChatRequest(title, content) };
        }
        try {
          return await pending.current.request;
        } catch (error) {
          pending.current = null;
          throw error;
        }
      }}
      onJobSubmitted={(origin, jobId) => {
        // The generation record already binds this message. Cache its direct id on
        // the message as well; a disconnected browser can recover from the binding.
        void messageService
          .updateMessageMetadata(origin.messageId, { presentationJobId: jobId }, origin)
          .then(({ messages }) => {
            if (messages)
              useChatStore
                .getState()
                .replaceMessages(messages, { context: { ...origin, scope: 'main' } });
          })
          .catch(() => undefined);
        pending.current = null;
        if (
          new URLSearchParams(window.location.search).get('chatAgentId') === origin.agentId &&
          window.location.pathname === '/presentation'
        )
          navigate(presentationChatHref(origin));
      }}
    />
  );
}
