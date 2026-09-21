'use client';

import { ChatInput, ChatInputActionBar } from '@lobehub/editor/react';
import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo } from 'react';

import { useChatInputStore } from '@/features/ChatInput/store';
import { QingzhouComposerOrnaments, qingzhouStyles } from '@/features/QingzhouBrand';
import dynamic from '@/libs/next/dynamic';

import ActionBar from '../ActionBar';
import InputEditor from '../InputEditor';
import SendArea from '../SendArea';

const FilePreview = dynamic(() => import('./FilePreview'), { ssr: false });

const styles = createStaticStyles(({ css }) => ({
  container: css``,
  expandedFrame: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    width: 100%;
    min-height: 0;
  `,
  fullscreen: css`
    position: absolute;
    z-index: 100;
    inset: 0;

    width: 100%;
    height: 100%;
    padding: 12px;

    background: ${cssVar.colorBgLayout};
  `,
}));

const DesktopChatInput = memo(() => {
  const [slashMenuRef, expand] = useChatInputStore((s) => [s.slashMenuRef, s.expand]);
  const leftActions = useChatInputStore((s) => s.leftActions);

  const fileNode = leftActions.flat().includes('fileUpload') && <FilePreview />;

  return (
    <>
      {!expand && fileNode}
      <Flexbox
        className={cx(styles.container, expand && styles.fullscreen)}
        paddingBlock={'0 12px'}
        paddingInline={12}
      >
        <div className={cx(qingzhouStyles.composer, expand && styles.expandedFrame)}>
          {!expand && <QingzhouComposerOrnaments />}
          <ChatInput
            fullscreen={expand}
            header={<ChatInputActionBar left={<ActionBar />} />}
            slashMenuRef={slashMenuRef}
            footer={
              <ChatInputActionBar
                left={<div />}
                right={<SendArea />}
                style={{
                  paddingRight: 8,
                }}
              />
            }
          >
            {expand && fileNode}
            <InputEditor defaultRows={1} />
          </ChatInput>
        </div>
      </Flexbox>
    </>
  );
});

DesktopChatInput.displayName = 'DesktopChatInput';

export default DesktopChatInput;
