import { Button } from '@lobehub/ui';
import { Input, Select } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ArrowUp, MessageCircle, Minus } from 'lucide-react';
import { type ComponentRef, memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../packages/runtime-contracts/src';

const styles = createStaticStyles(({ css, cssVar }) => ({
  dock: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-width: 0;
    padding-block: 8px 4px;
  `,
  composer: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;

    width: 100%;
    min-width: 0;
    height: clamp(220px, 38dvh, 420px);
    min-height: 0;
  `,
  capsule: css`
    cursor: pointer;

    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;

    width: min(560px, 100%);
    min-height: 44px;
    padding-block: 10px;
    padding-inline: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font: inherit;
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgElevated};

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  header: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  panel: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;

    width: 100%;
    min-height: 0;
    padding-block: 14px;
    padding-inline: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    background: ${cssVar.colorBgElevated};
  `,
  hint: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
  `,
  history: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
  `,
  message: css`
    padding: 12px;
    border-radius: 12px;

    overflow-wrap: anywhere;
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  footer: css`
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
  `,
}));

export interface ConversationPanelProps {
  focusKey?: number;
  hideTrigger?: boolean;
  job: PresentationJob;
  onCancel: (jobId: string) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  onRetry: (jobId: string) => Promise<void>;
  onSend: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  open?: boolean;
  selectedPage?: number;
}

export const ConversationPanel = memo<ConversationPanelProps>(
  ({
    focusKey = 0,
    hideTrigger = false,
    job,
    selectedPage,
    open: openProp,
    onOpenChange,
    onSend,
    onCancel,
    onRetry,
  }) => {
    const { t } = useTranslation('common');
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const open = openProp ?? uncontrolledOpen;
    const setOpen = onOpenChange ?? setUncontrolledOpen;
    const panelId = useId();
    const input = useRef<ComponentRef<typeof Input.TextArea>>(null);
    const capsule = useRef<HTMLButtonElement>(null);
    const [content, setContent] = useState('');
    const [target, setTarget] = useState<number>(0);
    const [sending, setSending] = useState(false);
    const requestId = useRef<string | null>(null);
    const history = useRef<HTMLDivElement>(null);
    const messages = job.messages ?? [];
    const lastMessageStatus = messages.at(-1)?.status;
    const active = job.state === 'running' || job.state === 'queued';
    useEffect(() => {
      history.current?.scrollTo?.({ top: history.current.scrollHeight, behavior: 'smooth' });
    }, [open, messages.length, lastMessageStatus]);
    useEffect(() => {
      if (open) input.current?.focus();
    }, [open, focusKey]);
    const collapse = () => {
      setOpen(false);
      if (!hideTrigger) requestAnimationFrame(() => capsule.current?.focus());
    };
    const send = async () => {
      if (!content.trim() || sending) return;
      setSending(true);
      requestId.current ??= crypto.randomUUID();
      try {
        if (
          await onSend(job.jobId, {
            content: content.trim(),
            requestId: requestId.current,
            target: target ? { type: 'slide', slideNumber: target } : { type: 'deck' },
          })
        ) {
          setContent('');
          requestId.current = null;
        }
      } finally {
        setSending(false);
      }
    };

    if (!open && hideTrigger) return null;

    return (
      <aside
        aria-label={t('presentationConversation.title')}
        className={open ? styles.composer : styles.dock}
        data-open={open ? 'true' : 'false'}
        data-testid="presentation-conversation"
      >
        {!open ? (
          <button
            aria-controls={panelId}
            aria-expanded={false}
            className={styles.capsule}
            data-testid="presentation-conversation-trigger"
            ref={capsule}
            type="button"
            onClick={() => setOpen(true)}
          >
            <MessageCircle aria-hidden size={18} strokeWidth={1.6} />
            {t('presentationConversation.open')}
          </button>
        ) : (
          <div
            className={styles.panel}
            id={panelId}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.stopPropagation();
                collapse();
              }
            }}
          >
            <div className={styles.header}>
              <Select
                aria-label={t('presentationConversation.target')}
                value={target}
                options={[
                  { value: 0, label: t('presentationConversation.deck') },
                  ...Array.from(
                    {
                      length: Math.max(
                        job.slideCount ?? 0,
                        selectedPage ?? 0,
                        job.artifactIds?.filter((id) => id.includes(':slide:')).length ?? 0,
                        1,
                      ),
                    },
                    (_, i) => ({
                      value: i + 1,
                      label: t('presentationConversation.page', { number: i + 1 }),
                    }),
                  ),
                ]}
                onChange={(value) => {
                  setTarget(value);
                  requestId.current = null;
                }}
              />
              <Button
                aria-label={t('presentationConversation.collapse')}
                data-testid="presentation-conversation-collapse"
                size="small"
                type="text"
                onClick={collapse}
              >
                <Minus aria-hidden size={16} />
              </Button>
            </div>
            {!!messages.length && (
              <div aria-live="polite" className={styles.history} ref={history} role="log">
                {messages.map((message) => (
                  <div key={message.requestId}>
                    <div className={styles.message}>
                      <p className={styles.hint}>
                        {message.target.type === 'slide'
                          ? t('presentationConversation.page', {
                              number: message.target.slideNumber,
                            })
                          : t('presentationConversation.deck')}
                      </p>
                      {message.content}
                    </div>
                    <p className={styles.hint}>
                      {t(`presentationConversation.${message.status}`)}
                      {message.error ? ` · ${message.error}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <Input.TextArea
              aria-label={t('presentationConversation.placeholder')}
              autoSize={{ minRows: 2, maxRows: 5 }}
              data-testid="presentation-conversation-input"
              maxLength={4000}
              placeholder={t('presentationConversation.placeholder')}
              ref={input}
              value={content}
              variant="borderless"
              onChange={(event) => {
                setContent(event.target.value);
                requestId.current = null;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className={styles.footer}>
              {active ? (
                <Button size="small" onClick={() => void onCancel(job.jobId)}>
                  {t('presentationConversation.cancel')}
                </Button>
              ) : job.state === 'failed' || job.state === 'cancelled' ? (
                <Button size="small" onClick={() => void onRetry(job.jobId)}>
                  {t('presentationConversation.retry')}
                </Button>
              ) : (
                <span />
              )}
              <Button
                aria-label={t('presentationConversation.send')}
                data-testid="presentation-conversation-send"
                disabled={!content.trim()}
                loading={sending}
                size="small"
                type="primary"
                onClick={() => void send()}
              >
                <ArrowUp aria-hidden size={16} />
              </Button>
            </div>
          </div>
        )}
      </aside>
    );
  },
);

ConversationPanel.displayName = 'ConversationPanel';
