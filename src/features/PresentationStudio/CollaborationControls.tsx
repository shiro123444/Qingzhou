import { Button } from '@lobehub/ui';
import { Drawer, Input, Select } from 'antd';
import { createStaticStyles } from 'antd-style';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PresentationCollaborationMode,
  PresentationCollaborationState,
  PresentationDecisionAnswer,
  PresentationJob,
} from '../../../packages/runtime-contracts/src';

const styles = createStaticStyles(({ css, cssVar }) => ({
  entry: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;

    padding-block: 6px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-block-end: 24px;

    h3,
    p {
      margin: 0;
    }

    p {
      line-height: 1.7;
      color: ${cssVar.colorTextSecondary};
    }
  `,
  question: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorFillQuaternary};
  `,
}));

export interface CollaborationControlsProps {
  collaboration?: PresentationCollaborationState;
  onAnswer: (input: PresentationDecisionAnswer) => Promise<boolean>;
  onMode: (mode: PresentationCollaborationMode) => Promise<unknown>;
  pending?: boolean;
  state: PresentationJob['state'];
  taskId: string;
}
export default function CollaborationControls({
  taskId,
  state,
  collaboration,
  pending = false,
  onAnswer,
  onMode,
}: CollaborationControlsProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [changingMode, setChangingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const question =
    state === 'waiting_input'
      ? collaboration?.decisions.findLast((item) => item.status !== 'answered')
      : undefined;
  const lastOpened = useRef<string | undefined>(undefined);
  const submission = useRef<PresentationDecisionAnswer | undefined>(undefined);
  useEffect(() => {
    if (question?.status === 'pending' && question.id !== lastOpened.current) {
      lastOpened.current = question.id;
      setContent('');
      setOpen(true);
    }
  }, [question?.id, question?.status]);
  const answer = async (action: PresentationDecisionAnswer['action'], answerContent?: string) => {
    if (!question || pending) return;
    const text = action === 'revise' ? (answerContent ?? content).trim() : undefined;
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
    if (await onAnswer(submission.current)) {
      setOpen(false);
      setContent('');
    }
  };
  const history = collaboration?.decisions.filter((item) => item.status === 'answered') ?? [];
  return (
    <>
      <div className={styles.entry} data-testid="presentation-collaboration-entry">
        <span>{t(`presentationCollaboration.mode.${collaboration?.mode ?? 'adaptive'}`)}</span>
        <Button size="small" type={question ? 'primary' : 'text'} onClick={() => setOpen(true)}>
          {t(question ? 'presentationCollaboration.pending' : 'presentationCollaboration.title')}
        </Button>
      </div>
      <Drawer
        open={open}
        size={440}
        title={t('presentationCollaboration.title')}
        onClose={() => setOpen(false)}
      >
        <section className={styles.section}>
          <label htmlFor={`presentation-collaboration-mode-${taskId}`}>
            {t('presentationCollaboration.preference')}
          </label>
          <Select
            disabled={changingMode}
            id={`presentation-collaboration-mode-${taskId}`}
            value={collaboration?.mode ?? 'adaptive'}
            options={(['adaptive', 'ask', 'auto'] as const).map((value) => ({
              value,
              label: t(`presentationCollaboration.mode.${value}`),
            }))}
            onChange={async (mode) => {
              setChangingMode(true);
              setModeError(null);
              try {
                await onMode(mode);
              } catch (error) {
                setModeError(error instanceof Error ? error.message : '协作偏好未保存，请重试');
              } finally {
                setChangingMode(false);
              }
            }}
          />
          <p>{t(`presentationCollaboration.policy.${collaboration?.mode ?? 'adaptive'}`)}</p>
          {modeError && <p role="alert">{modeError}</p>}
        </section>
        <section aria-live="polite" className={`${styles.section} ${styles.question}`}>
          <h3>{question?.title ?? t('presentationCollaboration.noQuestion')}</h3>
          <p>{question?.detail ?? t('presentationCollaboration.noQuestionDetail')}</p>
          {question && (
            <>
              {question.choices?.map((choice) => (
                <Button
                  disabled={pending}
                  key={choice.id}
                  title={choice.description}
                  onClick={() => void answer('revise', choice.label)}
                >
                  {choice.label}
                </Button>
              ))}
              {question.status === 'deferred' && <p>{t('presentationCollaboration.deferred')}</p>}
              <Input.TextArea
                aria-label={t('presentationCollaboration.input')}
                autoSize={{ minRows: 3, maxRows: 7 }}
                maxLength={3000}
                placeholder={t('presentationCollaboration.input')}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
              {question.options.map((option) => (
                <Button
                  aria-busy={pending}
                  aria-label={option.label}
                  disabled={pending || (option.id === 'revise' && !content.trim())}
                  key={option.id}
                  loading={pending}
                  title={option.description}
                  type={option.id === (content.trim() ? 'revise' : 'retry') ? 'primary' : 'default'}
                  onClick={() => void answer(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </>
          )}
        </section>
        <details className={styles.section}>
          <summary>{t('presentationCollaboration.history', { count: history.length })}</summary>
          {history.map((item) => (
            <div key={item.id}>
              <strong>{item.title}</strong>
              <p>{item.answer?.content ?? t('presentationCollaboration.retried')}</p>
            </div>
          ))}
        </details>
      </Drawer>
    </>
  );
}
