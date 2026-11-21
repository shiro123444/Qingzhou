import { Button } from '@lobehub/ui';
import { Input } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ArrowUp, ChevronDown, History, MessageCircle, Minus } from 'lucide-react';
import { type ComponentRef, memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BotMentionButton } from '@/features/BotSurface/context';

import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../packages/runtime-contracts/src';

const styles = createStaticStyles(({ css, cssVar }) => ({
  dock: css`
    flex: none;
    width: 100%;
    min-width: 0;
  `,
  capsule: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    margin: auto;
    width: min(560px, 100%);
    min-height: 44px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 24px;
    font: inherit;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgElevated};
    cursor: pointer;
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: min(820px, 100%);
    margin-inline: auto;
    padding: 8px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 22px;
    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 16px rgb(0 0 0 / 5%);
    box-sizing: border-box;

    @supports (backdrop-filter: blur(16px)) {
      background: color-mix(in srgb, ${cssVar.colorBgElevated} 88%, transparent);
      backdrop-filter: blur(16px) saturate(130%);
    }

    @media (prefers-reduced-transparency: reduce) {
      background: ${cssVar.colorBgElevated};
      backdrop-filter: none;
    }

    &:focus-within {
      border-color: ${cssVar.colorPrimaryBorder};
    }
  `,
  footer: css`
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    .ant-btn:last-child {
      margin-inline-start: auto;
    }
  `,
  scope: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    color: ${cssVar.colorText};
    select {
      cursor: pointer;
      appearance: none;
      max-width: 100%;
      border: 0;
      border-radius: 12px;
      padding: 5px 24px 5px 10px;
      background: ${cssVar.colorFillTertiary};
      color: inherit;
      font: inherit;
      font-size: 12px;
    }
    select:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
    }
    svg {
      position: absolute;
      inset-inline-end: 7px;
      pointer-events: none;
    }
  `,
  history: css`
    overflow-y: auto;
    max-height: min(23dvh, 200px);
    margin-block-end: 4px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 13px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    p {
      margin: 0 0 5px;
    }
    small {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  error: css`
    margin: 0;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
}));

export interface ConversationPanelProps {
  focusKey?: number;
  inline?: boolean;
  job: PresentationJob;
  onCancel: (jobId: string) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  onRetry: (jobId: string) => Promise<void>;
  onSend: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  open?: boolean;
  selectedPage?: number;
  pageCount?: number;
}

export const ConversationPanel = memo<ConversationPanelProps>(
  ({
    focusKey = 0,
    inline = false,
    job,
    pageCount,
    selectedPage = 1,
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
    const [draftTarget, setDraftTarget] = useState<number | 'deck'>();
    const [selection, setSelection] = useState<{ page: number; scope: number | 'deck' }>();
    const target =
      draftTarget ?? (selection?.page === selectedPage ? selection.scope : selectedPage);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState(false);
    const pending = useRef(false);
    const requestId = useRef<string | null>(null);
    const history = useRef<HTMLDivElement>(null);
    const messages = job.messages ?? [];
    const lastStatus = messages.at(-1)?.status;
    const active = job.state === 'running' || job.state === 'queued';
    const pages = Math.max(
      selectedPage,
      pageCount ??
        job.slideCount ??
        job.artifactIds?.filter((id) => id.includes(':slide:')).length ??
        1,
    );
    useEffect(() => {
      history.current?.scrollTo?.({ top: history.current.scrollHeight, behavior: 'smooth' });
    }, [open, messages.length, lastStatus]);
    useEffect(() => {
      if (open || focusKey) input.current?.focus();
    }, [open, focusKey]);
    useEffect(() => {
      setSelection(undefined);
    }, [selectedPage]);
    const collapse = () => {
      setOpen(false);
      if (!inline) requestAnimationFrame(() => capsule.current?.focus());
    };
    const send = async () => {
      if (!content.trim() || pending.current || (typeof target === 'number' && target > pages))
        return;
      pending.current = true;
      setSending(true);
      setSendError(false);
      requestId.current ??= crypto.randomUUID();
      try {
        const accepted = await onSend(job.jobId, {
          content: content.trim(),
          requestId: requestId.current,
          target: target === 'deck' ? { type: 'deck' } : { type: 'slide', slideNumber: target },
        });
        if (accepted) {
          setContent('');
          setSelection(undefined);
          setDraftTarget(undefined);
          requestId.current = null;
        } else {
          setSendError(true);
        }
      } catch {
        setSendError(true);
      } finally {
        pending.current = false;
        setSending(false);
      }
    };
    const placeholder =
      target === 'deck'
        ? t('presentationConversation.deckPlaceholder')
        : t('presentationConversation.pagePlaceholder', { number: target });

    return (
      <aside
        aria-label={t('presentationConversation.title')}
        className={styles.dock}
        data-open={open}
        data-testid="presentation-conversation"
      >
        {!inline && !open ? (
          <button
            aria-controls={panelId}
            aria-expanded={false}
            className={styles.capsule}
            data-testid="presentation-conversation-trigger"
            ref={capsule}
            type="button"
            onClick={() => setOpen(true)}
          >
            <MessageCircle aria-hidden size={18} />
            {t('presentationConversation.open')}
          </button>
        ) : (
          <div
            className={styles.panel}
            id={panelId}
            onKeyDown={(event) => {
              if (open && event.key === 'Escape' && !event.defaultPrevented) {
                event.stopPropagation();
                collapse();
              }
            }}
          >
            {open && messages.length > 0 && (
              <div aria-live="polite" className={styles.history} ref={history} role="log">
                {messages.map((message) => (
                  <div key={message.requestId}>
                    <small>
                      {message.target.type === 'slide'
                        ? t('presentationConversation.page', { number: message.target.slideNumber })
                        : t('presentationConversation.deck')}{' '}
                      · {t(`presentationConversation.${message.status}`)}
                    </small>
                    <p>
                      {message.content}
                      {message.error && ` · ${message.error}`}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <Input.TextArea
              data-bot-mention
              aria-label={placeholder}
              autoSize={{ minRows: 1, maxRows: 4 }}
              data-testid="presentation-conversation-input"
              disabled={sending}
              maxLength={4000}
              placeholder={placeholder}
              ref={input}
              value={content}
              variant="borderless"
              onChange={(event) => {
                const value = event.target.value;
                setDraftTarget(value.trim() ? target : undefined);
                if (!value.trim()) setSelection(undefined);
                setContent(value);
                setSendError(false);
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
              <label className={styles.scope}>
                <select
                  aria-label={t('presentationConversation.target')}
                  data-testid="presentation-conversation-scope"
                  disabled={sending}
                  value={target}
                  onChange={(event) => {
                    const scope =
                      event.target.value === 'deck' ? 'deck' : Number(event.target.value);
                    setSelection({ page: selectedPage, scope });
                    setDraftTarget(content.trim() ? scope : undefined);
                    setSendError(false);
                    requestId.current = null;
                  }}
                >
                  {Array.from({ length: pages }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {t('presentationConversation.page', { number: i + 1 })}
                    </option>
                  ))}
                  <option value="deck">{t('presentationConversation.deck')}</option>
                </select>
                <ChevronDown aria-hidden size={13} />
              </label>
              <BotMentionButton />
              {(open || messages.length > 0) && (
                <Button
                  aria-expanded={open}
                  aria-label={t(
                    open ? 'presentationConversation.collapse' : 'presentationEditor.edits',
                  )}
                  data-testid="presentation-conversation-collapse"
                  size="small"
                  type="text"
                  icon={open ? <Minus size={15} /> : <History size={15} />}
                  onClick={() => (open ? collapse() : setOpen(true))}
                />
              )}
              {active ? (
                <Button size="small" onClick={() => void onCancel(job.jobId)}>
                  {t('presentationConversation.cancel')}
                </Button>
              ) : (
                (job.state === 'failed' || job.state === 'cancelled') && (
                  <Button size="small" onClick={() => void onRetry(job.jobId)}>
                    {t('presentationConversation.retry')}
                  </Button>
                )
              )}
              <Button
                aria-label={t('presentationConversation.send')}
                data-testid="presentation-conversation-send"
                disabled={!content.trim() || (typeof target === 'number' && target > pages)}
                icon={<ArrowUp aria-hidden size={16} />}
                loading={sending}
                size="small"
                type="primary"
                onClick={() => void send()}
              />
            </div>
            {sendError && (
              <p className={styles.error} role="alert">
                {t('presentationConversation.sendError')}
              </p>
            )}
          </div>
        )}
      </aside>
    );
  },
);

ConversationPanel.displayName = 'ConversationPanel';
