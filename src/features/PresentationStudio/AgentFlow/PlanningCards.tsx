import { Button } from '@lobehub/ui';
import { Input } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo, type ReactNode, useEffect, useMemo, useState } from 'react';

import type { PresentationCreativePlan } from '@/types/presentationPlan';

import type {
  PresentationAgentBrief,
  PresentationAgentQuestion,
  PresentationAgentQuestionChoice,
} from './presentationAgentClient';

const styles = createStaticStyles(({ css, cssVar }) => ({
  answer: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: end;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  answerList: css`
    display: grid;
    gap: 8px;
    margin: 0;
  `,
  answerRow: css`
    display: grid;
    grid-template-columns: minmax(110px, 0.7fr) minmax(0, 1.3fr);
    gap: 12px;

    padding-block: 9px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    dt,
    dd {
      margin: 0;
      font-size: 12px;
      line-height: 1.55;
    }

    dt {
      color: ${cssVar.colorTextDescription};
    }

    dd {
      color: ${cssVar.colorText};
    }
  `,
  card: css`
    overflow: hidden;

    width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgContainer} 92%, transparent);
    box-shadow: 0 12px 34px rgb(0 0 0 / 4%);
  `,
  cardBody: css`
    display: grid;
    gap: 14px;
    padding: 18px;
  `,
  cardHeader: css`
    display: flex;
    gap: 14px;
    align-items: flex-start;
    justify-content: space-between;

    padding: 18px;
    border: 0;

    font: inherit;
    color: inherit;
    text-align: start;

    background: transparent;
  `,
  compactMeta: css`
    margin-block: 3px 0;
    margin-inline: 0;

    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorTextDescription};
  `,
  contextList: css`
    display: grid;
    gap: 7px;

    margin: 0;
    padding: 0;

    list-style: none;

    li {
      position: relative;

      padding-inline-start: 14px;

      font-size: 13px;
      line-height: 1.55;
      color: ${cssVar.colorTextSecondary};
    }

    li::before {
      content: '';

      position: absolute;
      inset-block-start: 0.72em;
      inset-inline-start: 0;

      width: 4px;
      height: 4px;
      border-radius: 50%;

      background: ${cssVar.colorTextQuaternary};
    }
  `,
  eyebrow: css`
    margin-block: 0 7px;
    margin-inline: 0;

    font-size: 11px;
    font-weight: 600;
    color: ${cssVar.colorTextDescription};
    letter-spacing: 0.12em;
  `,
  footer: css`
    display: grid;
    gap: 12px;

    box-sizing: border-box;
    width: min(100%, 760px);
    margin-inline: auto;
    padding-block: 8px 20px;
    padding-inline: 16px;
  `,
  goal: css`
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.45;
  `,
  overviewGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  overviewItem: css`
    min-width: 0;
    padding-block: 11px;
    padding-inline: 12px;
    border-radius: 12px;

    background: ${cssVar.colorFillQuaternary};
  `,
  overviewLabel: css`
    display: block;
    margin-block-end: 4px;
    font-size: 11px;
    color: ${cssVar.colorTextDescription};
  `,
  overviewValue: css`
    overflow: hidden;
    display: block;

    font-size: 13px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  planDetails: css`
    display: grid;
    gap: 14px;

    padding-block: 0 18px;
    padding-inline: 18px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  planNarrative: css`
    margin: 0;
    padding-block-start: 15px;

    font-size: 13px;
    line-height: 1.65;
    color: ${cssVar.colorTextSecondary};
  `,
  planStep: css`
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 10px;
    align-items: flex-start;

    & + & {
      margin-block-start: 10px;
    }
  `,
  planStepIndex: css`
    display: grid;
    place-items: center;

    width: 24px;
    height: 24px;
    border-radius: 50%;

    font-size: 11px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillSecondary};
  `,
  planStepText: css`
    margin-block: 1px 0;
    margin-inline: 0;
    font-size: 13px;
    line-height: 1.55;

    small {
      display: block;
      margin-block-start: 2px;
      font-size: 12px;
      color: ${cssVar.colorTextDescription};
    }
  `,
  questionCard: css`
    display: grid;
    gap: 12px;

    box-sizing: border-box;
    width: min(100%, 760px);
    margin-inline: auto;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    background: ${cssVar.colorBgContainer};
    box-shadow: 0 14px 40px rgb(0 0 0 / 6%);
  `,
  questionShell: css`
    position: relative;
    z-index: 2;

    flex: none;

    box-sizing: border-box;
    width: 100%;
    padding-block: 10px 28px;
    padding-inline: 16px;
  `,
  questionText: css`
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.6;
  `,
  choices: css`
    display: grid;
    gap: 8px;
  `,
  choice: css`
    cursor: pointer;

    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 10px;
    align-items: center;

    width: 100%;
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 13px;

    font: inherit;
    color: ${cssVar.colorText};
    text-align: start;

    background: ${cssVar.colorBgContainer};

    transition:
      border-color 160ms ease,
      background 160ms ease,
      transform 160ms ease;

    &:hover {
      transform: translateY(-1px);
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillQuaternary};
    }

    &[data-selected='true'] {
      border-color: color-mix(in srgb, ${cssVar.colorPrimary} 48%, ${cssVar.colorBorderSecondary});
      background: color-mix(in srgb, ${cssVar.colorPrimaryBg} 68%, transparent);
    }
  `,
  choiceIndex: css`
    display: grid;
    place-items: center;

    width: 26px;
    height: 26px;
    border-radius: 50%;

    font-size: 11px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillSecondary};
  `,
  choiceLabel: css`
    display: block;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.45;
  `,
  choiceDescription: css`
    display: block;

    margin-block-start: 2px;

    font-size: 12px;
    line-height: 1.45;
    color: ${cssVar.colorTextDescription};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  `,
  success: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;

    span {
      padding-block: 5px;
      padding-inline: 9px;
      border-radius: 999px;

      font-size: 11px;
      line-height: 1.3;
      color: ${cssVar.colorTextSecondary};

      background: ${cssVar.colorFillQuaternary};
    }
  `,
  toggle: css`
    cursor: pointer;

    flex: none;

    padding-block: 5px;
    padding-inline: 9px;
    border: 0;
    border-radius: 999px;

    font: inherit;
    font-size: 12px;
    color: ${cssVar.colorTextDescription};

    background: ${cssVar.colorFillQuaternary};
  `,
}));

export interface ConfirmedAgentAnswer {
  answer: string;
  id: string;
  question: string;
}

const cleanQuestionText = (value: string): string =>
  value
    .replaceAll('**', '')
    .replaceAll(/^\s*[•*-]\s*/gmu, '')
    .trim();

const predictedChoices = (prompt: string): PresentationAgentQuestionChoice[] => {
  if (/视频|字幕|影像/u.test(prompt) && /保留|替换/u.test(prompt))
    return [
      { id: 'keep-video', label: '保留原视频，更新字幕' },
      { id: 'replace-video', label: '替换为新的同类视频' },
      { id: 'poster', label: '改为静态主视觉' },
    ];
  if (/页数|多少页/u.test(prompt))
    return ['6–8 页精简版', '10–12 页标准版', '15 页以上完整版本'].map((label, index) => ({
      id: `slide-count-${index + 1}`,
      label,
    }));
  if (/主题|用途|场合|场景/u.test(prompt))
    return ['社团招新宣讲', '课程介绍', '项目汇报', '活动或品牌发布'].map((label, index) => ({
      id: `scenario-${index + 1}`,
      label,
    }));
  return [
    { id: 'recommended', label: '采用 Jumi 的推荐方案' },
    { id: 'preserve', label: '优先保留原模板表达' },
  ];
};

const organizeQuestion = (
  question: PresentationAgentQuestion | string,
): Required<Pick<PresentationAgentQuestion, 'prompt'>> & PresentationAgentQuestion => {
  if (typeof question !== 'string') {
    const prompt = cleanQuestionText(question.prompt);
    return {
      ...question,
      prompt,
      context: question.context?.map(cleanQuestionText).filter(Boolean).slice(0, 6),
      choices:
        question.choices?.map((choice) => ({
          ...choice,
          label: cleanQuestionText(choice.label),
        })) ?? predictedChoices(prompt),
    };
  }
  const cleaned = cleanQuestionText(question);
  const segments = cleaned
    .split(/\r?\n|\s+•\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const questionIndex = segments.findLastIndex((part) =>
    /[?？]|(?:请|需要).{0,24}(?:告知|确认|选择|决定)/u.test(part),
  );
  const prompt = questionIndex >= 0 ? segments[questionIndex] : segments.at(-1) || cleaned;
  const context = segments.filter((_, index) => index !== questionIndex).slice(-6);
  return {
    choices: predictedChoices(prompt),
    context,
    prompt,
    title: '确认关键决定',
  };
};

export const CreativePlanCard = memo<{ plan: PresentationCreativePlan }>(({ plan }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className={styles.card} data-testid="presentation-creative-plan">
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.eyebrow}>创作方案</p>
          <h3 className={styles.goal}>{plan.goal}</h3>
          <p className={styles.compactMeta}>{plan.narrative}</p>
        </div>
        <button
          aria-expanded={expanded}
          className={styles.toggle}
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>
      {expanded && (
        <div className={styles.planDetails}>
          <p className={styles.planNarrative}>{plan.rationale}</p>
          <div>
            {plan.steps.map((step, index) => (
              <div className={styles.planStep} key={`${step.action}:${index}`}>
                <span className={styles.planStepIndex}>{String(index + 1).padStart(2, '0')}</span>
                <p className={styles.planStepText}>
                  {step.action}
                  <small>{step.reason}</small>
                </p>
              </div>
            ))}
          </div>
          <div className={styles.success}>
            {plan.successCriteria.map((criterion) => (
              <span key={criterion}>{criterion}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
});

CreativePlanCard.displayName = 'CreativePlanCard';

export const AgentQuestionCard = memo<{
  answerCount: number;
  disabled?: boolean;
  onAnswerChange: (value: string) => void;
  onSubmit: () => void;
  question: PresentationAgentQuestion | string;
  value: string;
}>(({ answerCount, disabled, onAnswerChange, onSubmit, question, value }) => {
  const organized = useMemo(() => organizeQuestion(question), [question]);
  const [custom, setCustom] = useState(false);

  useEffect(() => setCustom(false), [organized.prompt]);

  return (
    <div className={styles.questionShell}>
      <section className={styles.questionCard} data-testid="presentation-agent-question">
        <div>
          <p className={styles.eyebrow}>等待你的决定 · 第 {answerCount + 1} 项</p>
          {organized.title && <p className={styles.sectionTitle}>{organized.title}</p>}
          <p className={styles.questionText}>{organized.prompt}</p>
        </div>
        {organized.context && organized.context.length > 0 && (
          <ul className={styles.contextList}>
            {organized.context.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div aria-label="Jumi 预测选项" className={styles.choices}>
          {organized.choices?.map((choice, index) => (
            <button
              className={styles.choice}
              data-selected={!custom && value === choice.label}
              disabled={disabled}
              key={choice.id}
              type="button"
              onClick={() => {
                setCustom(false);
                onAnswerChange(choice.label);
              }}
            >
              <span className={styles.choiceIndex}>{index + 1}</span>
              <span>
                <span className={styles.choiceLabel}>{choice.label}</span>
                {choice.description && (
                  <span className={styles.choiceDescription}>{choice.description}</span>
                )}
              </span>
            </button>
          ))}
          <button
            className={styles.choice}
            data-selected={custom}
            disabled={disabled}
            type="button"
            onClick={() => {
              setCustom(true);
              onAnswerChange('');
            }}
          >
            <span className={styles.choiceIndex}>{(organized.choices?.length ?? 0) + 1}</span>
            <span className={styles.choiceLabel}>其他，我自己填写</span>
          </button>
        </div>
        {custom && (
          <Input.TextArea
            autoFocus
            aria-label="回答当前问题"
            autoSize={{ maxRows: 5, minRows: 2 }}
            disabled={disabled}
            maxLength={2400}
            placeholder="输入你的决定…"
            value={value}
            onChange={(event) => onAnswerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
        )}
        <div className={styles.answer}>
          <p className={styles.compactMeta}>Jumi 已暂停执行，确认后继续判断下一步。</p>
          <Button disabled={disabled || !value.trim()} type="primary" onClick={onSubmit}>
            确认并继续
          </Button>
        </div>
      </section>
    </div>
  );
});

AgentQuestionCard.displayName = 'AgentQuestionCard';

export const BriefConfirmationCard = memo<{
  answers: ConfirmedAgentAnswer[];
  brief: PresentationAgentBrief;
  onConfirm: () => void;
}>(({ answers, brief, onConfirm }) => (
  <section className={styles.card} data-testid="presentation-agent-brief-confirmation">
    <div className={styles.cardBody}>
      <div>
        <p className={styles.eyebrow}>信息概述</p>
        <h3 className={styles.goal}>确认后进入逐页大纲</h3>
        <p className={styles.compactMeta}>已把你的逐项回答整理进当前对话。</p>
      </div>
      <div className={styles.overviewGrid}>
        <div className={styles.overviewItem}>
          <span className={styles.overviewLabel}>主题</span>
          <span className={styles.overviewValue}>{brief.topic || '待 Agent 归纳'}</span>
        </div>
        <div className={styles.overviewItem}>
          <span className={styles.overviewLabel}>受众与场景</span>
          <span className={styles.overviewValue}>{brief.audience || '根据内容自适应'}</span>
        </div>
        <div className={styles.overviewItem}>
          <span className={styles.overviewLabel}>预计页数</span>
          <span className={styles.overviewValue}>
            {brief.slideCount ? `${brief.slideCount} 页` : '由叙事结构决定'}
          </span>
        </div>
        <div className={styles.overviewItem}>
          <span className={styles.overviewLabel}>视觉方向</span>
          <span className={styles.overviewValue}>{brief.style || '由模板与内容共同决定'}</span>
        </div>
      </div>
      {answers.length > 0 && (
        <dl className={styles.answerList}>
          {answers.map((item) => (
            <div className={styles.answerRow} key={item.id}>
              <dt>{item.question}</dt>
              <dd>{item.answer}</dd>
            </div>
          ))}
        </dl>
      )}
      <Button type="primary" onClick={onConfirm}>
        确认信息，查看大纲
      </Button>
    </div>
  </section>
));

BriefConfirmationCard.displayName = 'BriefConfirmationCard';

export const PlanningCardsFooter = memo<{ children: ReactNode }>(({ children }) => (
  <div className={styles.footer}>{children}</div>
));

PlanningCardsFooter.displayName = 'PlanningCardsFooter';
