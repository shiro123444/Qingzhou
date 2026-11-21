import { Button, Icon } from '@lobehub/ui';
import { Input, Popover, Select } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ChevronDown, MessageSquareText, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { glassSurface } from '@/styles/liquidGlass';

import type {
  PresentationCollaborationMode,
  PresentationCollaborationState,
  PresentationDecision,
  PresentationDecisionAnswer,
  PresentationJob,
} from '../../../packages/runtime-contracts/src';
import { presentationStylePresets } from '../../../packages/runtime-contracts/src/presentation-style-presets';

const styles = createStaticStyles(({ css, cssVar }) => ({
  actionButtons: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    margin-inline-start: auto;

    @media (width <= 640px) {
      justify-content: stretch;

      > button {
        flex: 1;
      }
    }
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block-start: 2px;
  `,
  answerLabel: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  choice: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 3px;

    min-width: 0;
    padding-block: 9px;
    padding-inline: 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;

    font: inherit;
    text-align: start;

    background: transparent;

    transition:
      border-color 160ms ease,
      background 160ms ease;

    &:hover:not(:disabled) {
      border-color: ${cssVar.colorBorder};
      background: var(--qz-glass-surface, ${cssVar.colorFillQuaternary});
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    &[data-selected='true'] {
      border-color: ${cssVar.colorPrimaryBorder};
      background: var(--qz-glass-selection, ${cssVar.colorPrimaryBg});
    }

    &[data-has-preview='true'] {
      gap: 6px;
      padding: 4px;
    }
  `,
  choicePreview: css`
    overflow: hidden;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    background: var(--qz-glass-selection, ${cssVar.colorFillTertiary});

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  choiceLabel: css`
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  choices: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  contextDisclosure: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    summary {
      cursor: pointer;
      width: fit-content;
      border-radius: 4px;

      &:focus-visible {
        outline: 2px solid ${cssVar.colorPrimary};
        outline-offset: 2px;
      }
    }
  `,
  contextList: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;

    list-style: none;

    li {
      padding-block: 4px;
      padding-inline: 8px;
      border-radius: 999px;

      font-size: 11px;
      line-height: 1.35;
      color: ${cssVar.colorTextSecondary};

      background: var(--qz-glass-surface, ${cssVar.colorFillQuaternary});
    }
  `,
  decision: css`
    display: flex;
    flex-direction: column;
    gap: 10px;

    width: min(400px, calc(100vw - 64px));
    padding: 2px;

    @media (width <= 640px) {
      width: calc(100vw - 64px);
    }
  `,
  decisionPopover: css`
    .ant-popover-inner {
      padding: 12px;
    }
  `,
  decisionHeader: css`
    display: flex;
    flex-direction: column;
    gap: 5px;

    h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      line-height: 1.4;
      color: ${cssVar.colorText};
    }
  `,
  decisionMeta: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};

    &[data-expanded='false'] {
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
  `,
  collaborationRoot: css`
    pointer-events: none;
    position: absolute;
    z-index: 30;
    inset-block-start: 10px;
    inset-inline: 12px;
  `,
  collaborationInline: css`
    position: relative;
    inset-block-start: auto;
    inset-inline: auto;

    flex: none;

    width: 100%;
    padding-block: 2px 8px;
    padding-inline: 0;
  `,
  entry: css`
    pointer-events: none;
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;

    min-height: 32px;
    padding: 0;
    border: 0;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    button {
      pointer-events: auto;
    }
  `,
  entryStatus: css`
    display: inline-flex;
    gap: 7px;
    align-items: center;

    min-width: 0;

    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  entryQuestion: css`
    cursor: pointer;

    display: flex;
    gap: 7px;
    align-items: center;

    min-width: 0;
    max-width: min(440px, 65vw);
    padding-block: 7px;
    padding-inline: 10px;
    border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
    border-radius: 10px;

    font: inherit;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-align: start;

    background: transparent;

    > span:nth-child(2) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    > svg {
      flex: none;
      color: ${cssVar.colorTextTertiary};
    }

    &:hover {
      background: var(--qz-glass-selection, ${cssVar.colorFillTertiary});
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }
  `,
  entryTools: css`
    display: flex;
    gap: 2px;
    align-items: center;
    margin-inline-start: auto;
  `,
  error: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorError};
  `,
  historyAnswer: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
  historyItem: css`
    display: flex;
    flex-direction: column;
    gap: 3px;

    padding-block: 9px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    strong {
      font-size: 12px;
      font-weight: 500;
      color: ${cssVar.colorText};
    }
  `,
  sectionLabel: css`
    margin: 0;
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  settingsHint: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorTextDescription};
  `,
  settingsPopover: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;

    width: min(320px, calc(100vw - 48px));
    max-height: min(60dvh, 480px);

    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
    }
  `,
  settingsTrigger: css`
    && {
      width: 32px;
      height: 32px;
      border: 1px solid var(--qz-glass-border, ${cssVar.colorBorderSecondary});
      border-radius: 10px;
      background: transparent;
    }
  `,
  settingsSection: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    margin: 0;

    h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: ${cssVar.colorText};
    }

    label {
      font-size: 12px;
      font-weight: 500;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  stateDot: css`
    flex: none;

    width: 6px;
    height: 6px;
    border-radius: 999px;

    background: ${cssVar.colorTextQuaternary};

    &[data-pending='true'] {
      background: ${cssVar.colorWarning};
    }

    &[data-deferred='true'] {
      background: ${cssVar.colorTextTertiary};
    }
  `,
  summaryButton: css`
    height: auto;
    padding: 0;
    font-size: 12px;
  `,
}));

type DecisionChoice = NonNullable<PresentationDecision['choices']>[number];

const choicePreview = (choice: DecisionChoice) => {
  if (choice.thumbnailUrl) return choice.thumbnailUrl;
  return presentationStylePresets.some(({ id }) => id === choice.id)
    ? `/images/presentation-styles/${choice.id}-cover.svg`
    : undefined;
};

export interface CollaborationControlsProps {
  canvasSavePaused?: boolean;
  collaboration?: PresentationCollaborationState;
  layout?: 'floating' | 'inline';
  onAnswer: (input: PresentationDecisionAnswer) => Promise<boolean>;
  onMode: (mode: PresentationCollaborationMode) => Promise<unknown>;
  pending?: boolean;
  state: PresentationJob['state'];
  taskId: string;
}

export default function CollaborationControls({
  taskId,
  canvasSavePaused,
  state,
  collaboration,
  layout = 'floating',
  pending = false,
  onAnswer,
  onMode,
}: CollaborationControlsProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [content, setContent] = useState('');
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>();
  const [customAnswerOpen, setCustomAnswerOpen] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const question =
    state === 'waiting_input'
      ? collaboration?.decisions.findLast((item) => item.status !== 'answered')
      : undefined;
  const questionLabel = canvasSavePaused ? t('presentationCollaboration.canvasSavePaused') : question?.title;
  const questionId = question?.id;
  const questionStatus = question?.status;
  const submission = useRef<PresentationDecisionAnswer | undefined>(undefined);
  const settingsTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!questionId) {
      setExpanded(false);
      return;
    }
    setExpanded(false);
  }, [questionId, questionStatus]);

  useEffect(() => {
    setContent('');
    setSelectedChoiceId(undefined);
    setCustomAnswerOpen(false);
    setDetailExpanded(false);
    setSubmitError(null);
    submission.current = undefined;
  }, [questionId]);

  const selectedChoice = question?.choices?.find((choice) => choice.id === selectedChoiceId);
  const answerText = [selectedChoice?.label, content.trim()].filter(Boolean).join('\n');
  const canSubmitAnswer = Boolean(answerText) && !pending;
  const retryOption = question?.options.find((option) => option.id === 'retry');
  const canRetry =
    Boolean(retryOption) && (question?.category === 'quality' || question?.category === 'provider');
  const deferOption = question?.options.find((option) => option.id === 'defer');
  const isLongDetail = (question?.detail.length ?? 0) > 120;
  const hasChoices = Boolean(question?.choices?.length);
  const showAnswerInput = !hasChoices || customAnswerOpen;

  const answer = async (action: PresentationDecisionAnswer['action'], suppliedContent?: string) => {
    if (!question || pending) return;
    const text = action === 'revise' ? (suppliedContent ?? answerText).trim() : undefined;
    if (action === 'revise' && !text) return;
    if (
      submission.current?.decisionId !== question.id ||
      submission.current?.action !== action ||
      submission.current?.content !== text
    )
      submission.current = {
        decisionId: question.id,
        requestId: crypto.randomUUID(),
        action,
        content: text,
      };
    setSubmitError(null);
    try {
      if (await onAnswer(submission.current)) {
        setExpanded(false);
        setContent('');
        setSelectedChoiceId(undefined);
        setCustomAnswerOpen(false);
        submission.current = undefined;
      } else {
        setSubmitError(t('presentationCollaboration.submitFailed'));
      }
    } catch {
      setSubmitError(t('presentationCollaboration.submitFailed'));
    }
  };

  const history = collaboration?.decisions.filter((item) => item.status === 'answered') ?? [];
  const mode = collaboration?.mode ?? 'adaptive';
  const isPending = question?.status === 'pending';
  const isDeferred = question?.status === 'deferred';

  const decisionContent = question ? (
    <section
      aria-live="polite"
      className={styles.decision}
      data-testid="presentation-decision-card"
    >
      <div className={styles.decisionHeader}>
        <h3>{question.title}</h3>
        <p className={styles.decisionMeta} data-expanded={detailExpanded || !isLongDetail}>
          {question.detail}
        </p>
        {isLongDetail && (
          <Button
            className={styles.summaryButton}
            size="small"
            type="text"
            onClick={() => setDetailExpanded((value) => !value)}
          >
            {t(
              detailExpanded
                ? 'presentationCollaboration.collapseDetail'
                : 'presentationCollaboration.expandDetail',
            )}
          </Button>
        )}
      </div>

      {question.context && question.context.length > 0 && (
        <details className={styles.contextDisclosure}>
          <summary>{t('presentationCollaboration.context')}</summary>
          <ul className={styles.contextList}>
            {question.context.slice(0, 6).map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </details>
      )}

      {question.choices && question.choices.length > 0 && (
        <div className={styles.choices}>
          {question.choices.map((choice) => {
            const preview = choicePreview(choice);
            return (
              <button
                aria-pressed={selectedChoiceId === choice.id}
                className={styles.choice}
                data-has-preview={Boolean(preview)}
                data-selected={selectedChoiceId === choice.id}
                disabled={pending}
                key={choice.id}
                title={choice.description}
                type="button"
                onClick={() => {
                  setSelectedChoiceId((value) => (value === choice.id ? undefined : choice.id));
                  setSubmitError(null);
                }}
              >
                {preview && (
                  <span className={styles.choicePreview}>
                    <img alt="" src={preview} />
                  </span>
                )}
                <span className={styles.choiceLabel}>{choice.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {showAnswerInput && (
        <Input.TextArea
          aria-label={t('presentationCollaboration.answerLabel')}
          autoSize={{ maxRows: 4, minRows: 2 }}
          disabled={pending}
          id={`presentation-decision-answer-${taskId}`}
          maxLength={3000}
          placeholder={t('presentationCollaboration.answerPlaceholder')}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setSubmitError(null);
          }}
        />
      )}

      <div className={styles.actions}>
        {hasChoices && !customAnswerOpen && (
          <Button
            icon={<MessageSquareText size={14} />}
            size="small"
            type="text"
            onClick={() => setCustomAnswerOpen(true)}
          >
            {t('presentationCollaboration.answerLabel')}
          </Button>
        )}
        <div className={styles.actionButtons}>
          {canRetry && retryOption && (
            <Button
              aria-busy={pending}
              aria-label={retryOption.label}
              disabled={pending}
              loading={pending && !canSubmitAnswer}
              size="small"
              title={retryOption.description}
              type={canSubmitAnswer ? 'default' : 'primary'}
              onClick={() => void answer('retry')}
            >
              {retryOption.label}
            </Button>
          )}
          <Button
            aria-busy={pending}
            aria-label={t('presentationCollaboration.submit')}
            disabled={!canSubmitAnswer}
            loading={pending && canSubmitAnswer}
            size="small"
            type={canSubmitAnswer || !canRetry ? 'primary' : 'default'}
            onClick={() => void answer('revise')}
          >
            {t('presentationCollaboration.submit')}
          </Button>
          {deferOption && (
            <Button
              aria-label={deferOption.label}
              disabled={pending}
              size="small"
              title={deferOption.description}
              type="text"
              onClick={() => void answer('defer')}
            >
              {deferOption.label}
            </Button>
          )}
        </div>
      </div>
      {submitError && (
        <p className={styles.error} role="alert">
          {submitError}
        </p>
      )}
    </section>
  ) : null;

  const settingsContent = (
    <div
      aria-label={t('presentationCollaboration.settings')}
      className={styles.settingsPopover}
      role="dialog"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(false);
        settingsTrigger.current?.focus({ preventScroll: true });
      }}
    >
      <h2>{t('presentationCollaboration.settings')}</h2>
      <section className={styles.settingsSection}>
        <label htmlFor={`presentation-collaboration-mode-${taskId}`}>
          {t('presentationCollaboration.preference')}
        </label>
        <Select
          disabled={changingMode}
          id={`presentation-collaboration-mode-${taskId}`}
          style={{ width: '100%' }}
          value={mode}
          options={(['adaptive', 'ask', 'auto'] as const).map((value) => ({
            value,
            label: t(`presentationCollaboration.mode.${value}`),
          }))}
          onChange={async (nextMode) => {
            setChangingMode(true);
            setModeError(null);
            try {
              await onMode(nextMode);
            } catch (error) {
              setModeError(
                error instanceof Error ? error.message : t('presentationCollaboration.modeError'),
              );
            } finally {
              setChangingMode(false);
            }
          }}
        />
        {modeError && (
          <p className={styles.error} role="alert">
            {modeError}
          </p>
        )}
      </section>
      {history.length > 0 && (
        <section className={styles.settingsSection}>
          <h3>{t('presentationCollaboration.history', { count: history.length })}</h3>
          {history.map((item) => (
            <div className={styles.historyItem} key={item.id}>
              <strong>{item.title}</strong>
              <p className={styles.historyAnswer}>
                {item.answer?.content ?? t('presentationCollaboration.retried')}
              </p>
            </div>
          ))}
        </section>
      )}
    </div>
  );

  return (
    <div
      className={`${styles.collaborationRoot} ${layout === 'inline' ? styles.collaborationInline : ''}`}
      data-layout={layout}
      data-testid="presentation-collaboration-root"
    >
      {(question || history.length > 0) && (
        <div className={styles.entry} data-testid="presentation-collaboration-entry">
          {question && (
            <Popover
              arrow={false}
              className={styles.decisionPopover}
              content={decisionContent}
              open={expanded}
              placement="bottomLeft"
              trigger="click"
              onOpenChange={setExpanded}
            >
              <button
                aria-expanded={expanded}
                className={`${glassSurface} ${styles.entryQuestion}`}
                data-testid="presentation-collaboration-question-trigger"
                type="button"
                aria-label={`${t(
                  isDeferred
                    ? 'presentationCollaboration.deferredStatus'
                    : 'presentationCollaboration.pending',
                )}：${questionLabel}`}
              >
                <span
                  className={styles.stateDot}
                  data-deferred={isDeferred}
                  data-pending={isPending}
                />
                <span>{questionLabel}</span>
                <ChevronDown aria-hidden size={14} />
              </button>
            </Popover>
          )}
          <div className={styles.entryTools}>
            <Popover
              arrow={false}
              content={settingsContent}
              open={settingsOpen}
              placement="bottomRight"
              trigger="click"
              onOpenChange={(open) => {
                setSettingsOpen(open);
                if (!open) settingsTrigger.current?.focus({ preventScroll: true });
              }}
            >
              <Button
                aria-expanded={settingsOpen}
                aria-haspopup="dialog"
                aria-label={t('presentationCollaboration.openSettings')}
                className={`${glassSurface} ${styles.settingsTrigger}`}
                icon={<Icon icon={Settings2} size={15} />}
                ref={settingsTrigger}
                size="small"
                title={t('presentationCollaboration.settings')}
                type="text"
              />
            </Popover>
          </div>
        </div>
      )}
    </div>
  );
}
