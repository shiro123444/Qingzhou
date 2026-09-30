import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Alert, Drawer, Input, InputNumber } from 'antd';
import {
  ArrowUp,
  BookOpen,
  Check,
  LockKeyhole,
  Sparkles,
  Undo2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type LessonPlan, lessonPlanSchema, type TeacherBrief } from '@/types/presentationLesson';
import type { TeachingSelection } from '@/types/presentationTeaching';

import { lessonStyles as styles } from './lessonStyle';
import type { OutlineSlide } from './OutlineWorkspace';
import { TeachingMemoryWorkspace } from './TeachingMemoryWorkspace';

export interface LessonWorkspaceProps {
  audience?: string;
  busy?: boolean;
  initialSlides?: OutlineSlide[];
  onChange: (plan: LessonPlan | undefined) => void;
  onPlan: (
    brief: TeacherBrief,
    current?: LessonPlan,
    teachingSelection?: TeachingSelection,
    instruction?: string,
  ) => Promise<LessonPlan>;
  template?: { templateId: string; versionId?: string };
  topic?: string;
}

export function LessonWorkspace({
  audience = '',
  topic = '',
  initialSlides = [],
  busy = false,
  onChange,
  onPlan,
  template,
}: LessonWorkspaceProps) {
  const { t } = useTranslation('common');
  const [plan, setPlan] = useState<LessonPlan>();
  const [proposal, setProposal] = useState<LessonPlan>();
  const [history, setHistory] = useState<LessonPlan[]>([]);
  const [instruction, setInstruction] = useState('');
  const [duration, setDuration] = useState(45);
  const [opening, setOpening] = useState<'cover' | 'direct'>('cover');
  const [planning, setPlanning] = useState(false);
  const [memoryOpened, setMemoryOpened] = useState(false);
  const [teachingSelection, setTeachingSelection] = useState<TeachingSelection>({
    course: '',
    ids: [],
  });
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const active = useRef(true);
  const requestBusy = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const disabled = busy || planning;
  const shown = proposal ?? plan;
  const selectedBeat = shown?.beats.find(
    (b) => b.id === selected || b.frames.some((f) => f.id === selected),
  );
  const selectedFrame = selectedBeat?.frames.find((f) => f.id === selected);
  const changed =
    proposal?.beats.filter((b, i) => JSON.stringify(b) !== JSON.stringify(plan?.beats[i])).length ??
    0;
  const total = shown?.beats.reduce((sum, b) => sum + b.durationMinutes, 0);
  const commit = (next: LessonPlan) => {
    if (plan) setHistory((items) => [...items, plan].slice(-10));
    setPlan(next);
    setProposal(undefined);
    onChange(next);
  };
  const send = async () => {
    if (disabled || requestBusy.current || proposal || !instruction.trim()) return;
    requestBusy.current = true;
    setPlanning(true);
    setError(undefined);
    onChange(undefined);
    const brief: TeacherBrief = plan?.brief ?? {
      intention: instruction.trim().slice(0, 2000),
      audience: audience || t('presentationLesson.audienceUnknown'),
      priorKnowledge: '',
      learningGoal:
        topic ||
        initialSlides
          .map((s) => s.title)
          .slice(0, 4)
          .join('；') ||
        instruction.trim().slice(0, 2000),
      durationMinutes: duration,
      opening,
    };
    try {
      const request = selectedBeat
        ? `${instruction.trim()}\n本轮选择：环节 ${selectedBeat.id}${selectedFrame ? `，页面 ${selectedFrame.id}` : ''}。除必要衔接外保留其他环节。`
        : instruction.trim();
      const next = lessonPlanSchema.parse(await onPlan(brief, plan, teachingSelection, request));
      if (active.current) {
        setProposal(next);
        setInstruction('');
      }
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : t('presentationLesson.failed'));
        onChange(plan);
      }
    } finally {
      requestBusy.current = false;
      if (active.current) setPlanning(false);
    }
  };
  return (
    <Flexbox className={styles.workspace} data-testid="lesson-workspace" gap={16}>
      <Flexbox horizontal align="center" gap={12} justify="space-between">
        <Flexbox gap={4}>
          <h2 className={styles.intro}>{t('presentationLesson.conversationTitle')}</h2>
          <span className={styles.muted}>
            {shown
              ? t('presentationLesson.rhythm', { count: shown.beats.length, minutes: total })
              : t('presentationLesson.conversationHint')}
          </span>
        </Flexbox>
        <Button icon={<Icon icon={BookOpen} />} type="text" onClick={() => setMemoryOpened(true)}>
          {t('presentationTeaching.title')}
        </Button>
      </Flexbox>
      {proposal && (
        <Flexbox
          horizontal
          align="center"
          className={styles.changes}
          gap={8}
          justify="space-between"
          role="status"
          wrap="wrap"
        >
          <span>{t('presentationLesson.proposalSummary', { count: changed })}</span>
          <Flexbox horizontal gap={8}>
            <Button
              disabled={disabled}
              icon={<Icon icon={X} />}
              onClick={() => {
                setProposal(undefined);
                onChange(plan);
              }}
            >
              {t('presentationLesson.discard')}
            </Button>
            <Button
              data-testid="lesson-accept"
              disabled={disabled}
              icon={<Icon icon={Check} />}
              type="primary"
              onClick={() => commit(proposal)}
            >
              {t('presentationLesson.accept')}
            </Button>
          </Flexbox>
        </Flexbox>
      )}
      {shown && (
        <div aria-label={t('presentationLesson.timeline')} className={styles.timeline}>
          {shown.beats.map((beat, index) => (
            <section className={styles.beat} key={beat.id}>
              <Flexbox horizontal align="center" gap={8} justify="space-between">
                <button className={styles.beatTitle} onClick={() => setSelected(beat.id)}>
                  {index + 1}. {beat.title}
                </button>
                <Flexbox horizontal align="center" gap={8}>
                  <span className={styles.muted}>
                    {beat.durationMinutes} {t('presentationLesson.minutes')}
                  </span>
                  <Button
                    aria-label={t('presentationLesson.lock')}
                    aria-pressed={beat.locked}
                    disabled={disabled || !!proposal}
                    icon={<Icon icon={beat.locked ? LockKeyhole : UnlockKeyhole} size={16} />}
                    size="small"
                    type="text"
                    onClick={() =>
                      plan &&
                      commit({
                        ...plan,
                        beats: plan.beats.map((b) =>
                          b.id === beat.id ? { ...b, locked: !b.locked } : b,
                        ),
                      })
                    }
                  />
                </Flexbox>
              </Flexbox>
              <div className={styles.frames}>
                {beat.frames.map((frame) => (
                  <button
                    aria-pressed={selected === frame.id}
                    className={styles.frame}
                    key={frame.id}
                    onClick={() => setSelected(selected === frame.id ? undefined : frame.id)}
                  >
                    <span className={styles.muted}>
                      {t(`presentationLesson.kind.${frame.kind}`)}
                      {frame.boardSpace === 'right-third'
                        ? ` · ${t('presentationLesson.board')}`
                        : ''}
                    </span>
                    <strong className={styles.frameTitle}>{frame.title}</strong>
                  </button>
                ))}
              </div>
              {selectedBeat?.id === beat.id && (
                <div className={styles.preview}>
                  {selectedFrame ? (
                    <>
                      <p>
                        {selectedFrame.visibleContent.join(' / ') ||
                          t('presentationLesson.visualOnly')}
                      </p>
                      <p className={styles.muted}>{selectedFrame.visualCue}</p>
                    </>
                  ) : (
                    <p>{beat.objective}</p>
                  )}
                  <p className={styles.muted}>
                    {t('presentationLesson.teacherCue')}：{beat.teacherCue}
                  </p>
                  <p className={styles.muted}>
                    {t('presentationLesson.studentAction')}：{beat.studentAction}
                  </p>
                  {selectedFrame?.withheldContent.length ? (
                    <p className={styles.muted}>
                      {t('presentationLesson.withheldContent')}：
                      {selectedFrame.withheldContent.join(' / ')}
                    </p>
                  ) : null}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      {error && <Alert message={error} role="alert" type="error" />}
      <Flexbox className={styles.composer} gap={10}>
        {selectedBeat && (
          <Flexbox horizontal align="center" gap={8}>
            <span className={styles.muted}>
              {t('presentationLesson.editing')} {selectedFrame?.title ?? selectedBeat.title}
            </span>
            <Button
              aria-label={t('presentationLesson.clearSelection')}
              icon={<Icon icon={X} size={14} />}
              size="small"
              type="text"
              onClick={() => setSelected(undefined)}
            />
          </Flexbox>
        )}
        {!shown && (
          <Flexbox horizontal align="center" gap={12} wrap="wrap">
            <span className={styles.muted}>
              {audience || t('presentationLesson.audienceUnknown')}
            </span>
            <InputNumber
              aria-label={t('presentationLesson.duration')}
              disabled={disabled}
              max={240}
              min={1}
              suffix={t('presentationLesson.minutes')}
              value={duration}
              onChange={(v) => setDuration(v ?? 45)}
            />
            <Button
              aria-pressed={opening === 'cover'}
              disabled={disabled}
              type="text"
              onClick={() => setOpening(opening === 'cover' ? 'direct' : 'cover')}
            >
              {t(
                opening === 'cover'
                  ? 'presentationLesson.coverOpening'
                  : 'presentationLesson.directOpening',
              )}
            </Button>
          </Flexbox>
        )}
        <Input.TextArea
          aria-label={t('presentationLesson.chatInput')}
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={disabled || !!proposal}
          maxLength={3700}
          value={instruction}
          variant="borderless"
          placeholder={t(
            plan ? 'presentationLesson.revisePlaceholder' : 'presentationLesson.startPlaceholder',
          )}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Flexbox horizontal align="center" gap={10} justify="space-between">
          <Flexbox horizontal gap={8}>
            {!shown && (
              <Button
                icon={<Icon icon={Sparkles} size={14} />}
                size="small"
                type="text"
                onClick={() => setInstruction(t('presentationLesson.startSuggestion'))}
              >
                {t('presentationLesson.suggestionLabel')}
              </Button>
            )}
            {!!history.length && (
              <Button
                disabled={disabled || !!proposal}
                icon={<Icon icon={Undo2} size={16} />}
                type="text"
                onClick={() => {
                  const previous = history.at(-1)!;
                  setHistory(history.slice(0, -1));
                  setPlan(previous);
                  onChange(previous);
                }}
              >
                {t('presentationLesson.undo')}
              </Button>
            )}
            {planning && (
              <span className={styles.muted} role="status">
                {t('presentationLesson.thinking')}
              </span>
            )}
          </Flexbox>
          <Button
            aria-label={t('presentationLesson.send')}
            data-testid="lesson-plan-propose"
            disabled={disabled || !!proposal || !instruction.trim()}
            icon={<Icon icon={ArrowUp} size={18} />}
            loading={planning}
            type="primary"
            onClick={() => void send()}
          >
            {t('presentationLesson.send')}
          </Button>
        </Flexbox>
      </Flexbox>
      <Drawer
        open={memoryOpened}
        size={520}
        title={t('presentationTeaching.title')}
        onClose={() => setMemoryOpened(false)}
      >
        {memoryOpened && (
          <TeachingMemoryWorkspace
            disabled={disabled || !!proposal}
            selection={teachingSelection}
            template={template}
            onChange={setTeachingSelection}
          />
        )}
      </Drawer>
    </Flexbox>
  );
}
