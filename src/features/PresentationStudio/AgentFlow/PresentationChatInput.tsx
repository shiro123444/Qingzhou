'use client';
import { Button, Icon } from '@lobehub/ui';
import { Paperclip } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router-dom';

import DragUploadZone from '@/components/DragUploadZone';
import {
  type ActionKeys,
  type ChatInputEditor,
  ChatInputProvider,
  DesktopChatInput,
} from '@/features/ChatInput';
import ConversationChatInput from '@/features/Conversation/ChatInput';
import { fileChatSelectors, useFileStore } from '@/store/file';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import { PresentationTools, type PresentationToolSelection } from './PresentationTools';
import { type PresentationReferenceInput, toPresentationReference } from './types';

const DIRECT_LEFT_ACTIONS: ActionKeys[] = [];
const DIRECT_RIGHT_ACTIONS: ActionKeys[] = [];

// PPT exposes only the model and context capabilities connected to its Cordis runtime.
const CONVERSATION_LEFT_ACTIONS: ActionKeys[] = ['model'];
const CONVERSATION_RIGHT_ACTIONS: ActionKeys[] = ['contextWindow'];

export interface PresentationSendPayload {
  references: PresentationReferenceInput[];
  text: string;
  tools?: PresentationToolSelection;
}

export interface PresentationChatInputProps {
  agentId?: string;
  conversation?: boolean;
  creating?: boolean;
  disabled?: boolean;
  onEditorReady?: (editor: ChatInputEditor) => void;
  onSend: (payload: PresentationSendPayload) => void;
  onStop?: () => void;
  onToolsChange?: (value: PresentationToolSelection) => void;
  placeholder?: string;
  tools?: PresentationToolSelection;
}

const PresentationChatInputInner = memo<PresentationChatInputProps>(
  ({
    agentId,
    tools,
    onToolsChange,
    conversation = false,
    creating = false,
    disabled = false,
    onEditorReady,
    onSend,
    onStop,
    placeholder,
  }) => {
    const editorRef = useRef<ChatInputEditor | null>(null);

    const uploadInput = useRef<HTMLInputElement>(null);
    const [uploadError, setUploadError] = useState('');
    const handleUploadFiles = useCallback(async (files: File[]) => {
      setUploadError('');
      const dispatch = useFileStore.getState().dispatchChatUploadFileList;
      for (const file of files) {
        const temporaryId = `upload-${crypto.randomUUID()}`;
        dispatch({ type: 'addFiles', files: [{ id: temporaryId, file, status: 'uploading' }] });
        try {
          const body = new FormData();
          body.append('file', file);
          const response = await fetch('/api/runtime/presentation/conversation', {
            method: 'POST',
            body,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error?.message || '附件上传失败');
          dispatch({
            type: 'updateFile',
            id: temporaryId,
            value: { id: result.id, fileUrl: result.url, status: 'success' },
          });
        } catch (cause) {
          setUploadError(cause instanceof Error ? cause.message : '附件上传失败');
          dispatch({ type: 'removeFile', id: temporaryId });
        }
      }
    }, []);
    const uploadAction = {
      key: 'presentation-upload',
      children: (
        <>
          <Button
            aria-label="上传 PPT 附件"
            icon={<Icon icon={Paperclip} size={22} />}
            type="text"
            onClick={() => uploadInput.current?.click()}
          />
          <input
            hidden
            multiple
            accept=".txt,.md,.csv,.tsv,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp"
            ref={uploadInput}
            type="file"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void handleUploadFiles(files);
            }}
          />
        </>
      ),
    };
    const isUploadingFiles = useFileStore(fileChatSelectors.isUploadingFiles);

    const handleSend = useCallback(
      (handlers: any) => {
        const text =
          typeof handlers === 'string'
            ? handlers
            : handlers?.getMarkdownContent?.() || handlers?.text || '';

        const rawFiles = fileChatSelectors.chatUploadFileList(useFileStore.getState());
        const references: PresentationReferenceInput[] = rawFiles.map(toPresentationReference);

        const trimmedText = text.trim();
        if (!trimmedText && references.length === 0) return;

        onSend({ references, text: trimmedText, tools });
        handlers?.clearContent?.();
        useFileStore.getState().clearChatUploadFileList();
      },
      [onSend, tools],
    );

    if (conversation) {
      return (
        <div
          data-testid="presentation-chat-input-adapter"
          style={{ position: 'relative', width: '100%' }}
        >
          {uploadError && <p role="alert">{uploadError}</p>}
          <DragUploadZone
            style={{ position: 'relative', width: '100%', zIndex: 1 }}
            onUploadFiles={handleUploadFiles}
          >
            <ConversationChatInput
              allowExpand
              isConfigLoading={false}
              leftActions={CONVERSATION_LEFT_ACTIONS}
              placeholder={placeholder}
              rightActions={CONVERSATION_RIGHT_ACTIONS}
              showRuntimeConfig={false}
              extraActionItems={
                tools && onToolsChange
                  ? [
                      uploadAction,
                      {
                        key: 'presentation-tools',
                        children: <PresentationTools value={tools} onChange={onToolsChange} />,
                      },
                    ]
                  : [uploadAction]
              }
              sendButtonProps={{
                disabled: (disabled && !creating) || isUploadingFiles,
                generating: creating,
                onStop,
                shape: 'round',
              }}
              onEditorReady={onEditorReady}
            />
          </DragUploadZone>
        </div>
      );
    }

    return (
      <div
        data-testid="presentation-chat-input-adapter"
        style={{
          boxSizing: 'border-box',
          margin: '0 auto',
          maxWidth: 1080,
          paddingBottom: 16,
          paddingInline: 16,
          position: 'relative',
          width: '100%',
        }}
      >
        {uploadError && <p role="alert">{uploadError}</p>}
        <DragUploadZone
          style={{ position: 'relative', width: '100%', zIndex: 1 }}
          onUploadFiles={handleUploadFiles}
        >
          <ChatInputProvider
            allowExpand
            disableMention
            disableSlash
            agentId={agentId}
            leftActions={DIRECT_LEFT_ACTIONS}
            rightActions={DIRECT_RIGHT_ACTIONS}
            chatInputEditorRef={(instance) => {
              editorRef.current = instance;
              if (instance) onEditorReady?.(instance);
            }}
            sendButtonProps={{
              disabled: (disabled && !creating) || isUploadingFiles,
              generating: creating,
              onStop: onStop ?? (() => {}),
              shape: 'round',
            }}
            onSend={handleSend}
          >
            <DesktopChatInput
              borderRadius={16}
              isConfigLoading={false}
              showFootnote={false}
              showRuntimeConfig={false}
              extraActionItems={
                tools && onToolsChange
                  ? [
                      uploadAction,
                      {
                        key: 'presentation-tools',
                        children: <PresentationTools value={tools} onChange={onToolsChange} />,
                      },
                    ]
                  : [uploadAction]
              }
              placeholder={
                placeholder ??
                '拖入图片、PPT、PDF 或输入你的演示文稿主题（例如：2026年企业数字化转型与AI赋能战略汇报）...'
              }
            />
          </ChatInputProvider>
        </DragUploadZone>
      </div>
    );
  },
);

export const PresentationChatInput = memo<PresentationChatInputProps>((props) => {
  let inRouter = false;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    inRouter = useInRouterContext();
  } catch {}

  const content = (
    <ServerConfigStoreProvider>
      <PresentationChatInputInner {...props} />
    </ServerConfigStoreProvider>
  );

  if (!inRouter) {
    return <MemoryRouter>{content}</MemoryRouter>;
  }

  return content;
});

PresentationChatInput.displayName = 'PresentationChatInput';

export default PresentationChatInput;
