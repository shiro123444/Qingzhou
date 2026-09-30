import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Drawer, Input } from 'antd';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Columns3,
  Copy,
  Grid2X2,
  Minus,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { lessonOutline, type LessonPlan, type TeacherBrief } from '@/types/presentationLesson';
import type { TeachingSelection } from '@/types/presentationTeaching';

import { LessonWorkspace } from './LessonWorkspace';
import { styles } from './storyboardStyle';

export interface OutlineSlide {
  claim?: string;
  id: string;
  keyPoints: string[];
  objective?: string;
  speakerNotes?: string;
  title: string;
  visualSuggestion?: string;
}

export interface OutlineWorkspaceProps {
  audience?: string;
  creating?: boolean;
  initialSlides: OutlineSlide[];
  onAiRewrite: (input: {
    allSlides: OutlineSlide[];
    index?: number;
    mode: 'all' | 'slide';
    slide?: OutlineSlide;
  }) => Promise<Partial<OutlineSlide> | OutlineSlide[] | void>;
  onBack: () => void;
  onConfirm: (data: { slides: OutlineSlide[]; versionId: string; lessonPlan?: LessonPlan }) => void;
  onPlanLesson?: (
    brief: TeacherBrief,
    current?: LessonPlan,
    teachingSelection?: TeachingSelection,
    instruction?: string,
  ) => Promise<LessonPlan>;
  template?: { templateId: string; versionId?: string };
}

const mergeAiSlides = (
  current: readonly OutlineSlide[],
  candidate: readonly OutlineSlide[],
): OutlineSlide[] =>
  current.map((slide, index) => ({
    ...slide,
    ...candidate[index],
    id: slide.id,
    keyPoints:
      Array.isArray(candidate[index]?.keyPoints) && candidate[index].keyPoints.length > 0
        ? candidate[index].keyPoints
        : slide.keyPoints,
  }));

export const OutlineWorkspace = memo<OutlineWorkspaceProps>(
  ({
    initialSlides,
    onAiRewrite,
    onBack,
    onConfirm,
    onPlanLesson,
    audience,
    template,
    creating = false,
  }) => {
    const { t } = useTranslation('common');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rail, setRail] = useState(false);
    const [versionCount, setVersionCount] = useState(1);
    const [aiBusy, setAiBusy] = useState<'all' | number | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [slides, setSlides] = useState<OutlineSlide[]>(() => initialSlides);
    const [teaching, setTeaching] = useState(false);
    const [lessonPlan, setLessonPlan] = useState<LessonPlan>();

    const bumpVersion = useCallback(() => {
      setVersionCount((v) => v + 1);
    }, []);

    const handleUpdateTitle = useCallback(
      (index: number, newTitle: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], title: newTitle };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateClaim = useCallback(
      (index: number, newClaim: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], claim: newClaim };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateVisual = useCallback(
      (index: number, newVisual: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], visualSuggestion: newVisual };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdateSpeakerNotes = useCallback(
      (index: number, newNotes: string) => {
        setSlides((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], speakerNotes: newNotes };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleUpdatePoint = useCallback(
      (slideIndex: number, pointIndex: number, newPoint: string) => {
        setSlides((prev) => {
          const next = [...prev];
          const updatedPoints = [...next[slideIndex].keyPoints];
          updatedPoints[pointIndex] = newPoint;
          next[slideIndex] = { ...next[slideIndex], keyPoints: updatedPoints };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleAddPoint = useCallback(
      (slideIndex: number) => {
        setSlides((prev) => {
          const next = [...prev];
          next[slideIndex] = {
            ...next[slideIndex],
            keyPoints: [...next[slideIndex].keyPoints, ''],
          };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleRemovePoint = useCallback(
      (slideIndex: number, pointIndex: number) => {
        setSlides((prev) => {
          const next = [...prev];
          const updatedPoints = next[slideIndex].keyPoints.filter((_, idx) => idx !== pointIndex);
          next[slideIndex] = { ...next[slideIndex], keyPoints: updatedPoints };
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleMoveSlide = useCallback(
      (index: number, direction: -1 | 1) => {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= slides.length) return;
        setSlides((prev) => {
          const next = [...prev];
          const temp = next[index];
          next[index] = next[targetIndex];
          next[targetIndex] = temp;
          return next;
        });
        bumpVersion();
      },
      [slides.length, bumpVersion],
    );

    const handleDuplicateSlide = useCallback(
      (index: number) => {
        setSlides((prev) => {
          const next = [...prev];
          const source = next[index];
          const duplicated: OutlineSlide = {
            ...source,
            id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            keyPoints: [...source.keyPoints],
            title: `${source.title} (副本)`,
          };
          next.splice(index + 1, 0, duplicated);
          return next;
        });
        bumpVersion();
      },
      [bumpVersion],
    );

    const handleDeleteSlide = useCallback(
      (index: number) => {
        if (slides.length <= 1) return;
        setSlides((prev) => prev.filter((_, idx) => idx !== index));
        bumpVersion();
      },
      [slides.length, bumpVersion],
    );

    const handleAddSlide = useCallback(() => {
      setSlides((prev) => [
        ...prev,
        {
          id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          keyPoints: [''],
          objective: '',
          speakerNotes: '',
          title: `新幻灯片 ${prev.length + 1}`,
          visualSuggestion: '',
        },
      ]);
      bumpVersion();
    }, [bumpVersion]);

    const handleAiRewriteSlide = useCallback(
      async (index: number) => {
        if (aiBusy !== null) return;
        setAiBusy(index);
        try {
          const result = await onAiRewrite({
            allSlides: slides,
            index,
            mode: 'slide',
            slide: slides[index],
          });
          if (result && !Array.isArray(result)) {
            setSlides((prev) => {
              const next = [...prev];
              next[index] = { ...next[index], ...result };
              return next;
            });
            bumpVersion();
          } else {
            setAiError('AI 未返回可用的单页改写结果，请重试。');
          }
        } catch {
          setAiError('AI 大纲服务暂时不可用，请检查配置后重试。');
        } finally {
          setAiBusy(null);
        }
      },
      [aiBusy, bumpVersion, onAiRewrite, slides],
    );

    const handleAiOptimizeAll = useCallback(async () => {
      if (aiBusy !== null) return;
      setAiBusy('all');
      try {
        const result = await onAiRewrite({ allSlides: slides, mode: 'all' });
        if (Array.isArray(result) && result.length > 0) {
          setSlides((current) => mergeAiSlides(current, result));
          bumpVersion();
        } else {
          setAiError('AI 未返回可用的大纲结果，请重试。');
        }
      } catch {
        setAiError('AI 大纲服务暂时不可用，请检查配置后重试。');
      } finally {
        setAiBusy(null);
      }
    }, [aiBusy, bumpVersion, onAiRewrite, slides]);

    const versionId = useMemo(() => `v${versionCount}`, [versionCount]);

    const selectedIndex = slides.findIndex((slide) => slide.id === selectedId);
    const selected = slides[selectedIndex];
    const locked = creating || aiBusy !== null;
    return (
      <section
        aria-label="逐页大纲编辑工作区"
        className={styles.workspace}
        data-testid="presentation-agent-outline"
      >
        <div className={styles.header}>
          <Flexbox horizontal align="center" gap={12}>
            <Button
              aria-label="返回对话"
              icon={<Icon icon={ArrowLeft} size={20} />}
              type="text"
              onClick={onBack}
            />
            <span className={styles.count}>
              {t('presentationStoryboard.pages', {
                count: teaching && lessonPlan ? lessonOutline(lessonPlan).length : slides.length,
              })}
            </span>
          </Flexbox>
          <Flexbox horizontal align="center" gap={8}>
            {onPlanLesson && (
              <Button
                aria-pressed={teaching}
                disabled={creating || aiBusy !== null}
                onClick={() => {
                  setTeaching(!teaching);
                  setSelectedId(null);
                }}
              >
                {t('presentationLesson.mode')}
              </Button>
            )}
            <Button
              aria-label={t('presentationStoryboard.view')}
              aria-pressed={rail}
              icon={<Icon icon={rail ? Grid2X2 : Columns3} size={21} />}
              type="text"
              onClick={() => setRail(!rail)}
            />
            <Button
              aria-label="AI 整体优化"
              disabled={locked || teaching}
              icon={<Icon icon={Sparkles} size={21} />}
              loading={aiBusy === 'all'}
              type="text"
              onClick={() => void handleAiOptimizeAll()}
            />
            <Button
              aria-label="添加页面"
              disabled={locked || teaching}
              icon={<Icon icon={Plus} size={22} />}
              type="text"
              onClick={handleAddSlide}
            />
            <Button
              aria-label="确认大纲，继续生成"
              disabled={aiBusy !== null || !slides.length || (teaching && !lessonPlan)}
              loading={creating}
              type="primary"
              onClick={() =>
                onConfirm(
                  teaching && lessonPlan
                    ? { slides: lessonOutline(lessonPlan), versionId, lessonPlan }
                    : { slides, versionId },
                )
              }
            >
              {t('presentationStoryboard.create')}
            </Button>
          </Flexbox>
        </div>
        {aiError && <div role="alert">{aiError}</div>}
        {onPlanLesson && (
          <div hidden={!teaching}>
            <LessonWorkspace
              audience={audience}
              busy={creating}
              initialSlides={initialSlides}
              template={template}
              topic={initialSlides[0]?.title ?? ''}
              onChange={setLessonPlan}
              onPlan={onPlanLesson}
            />
          </div>
        )}
        {!teaching && (
          <>
            <div
              aria-label="大纲总览"
              className={rail ? styles.rail : styles.grid}
              data-testid="outline-overview"
            >
              {slides.map((slide, index) => (
                <button
                  aria-label={`第 ${index + 1} 页 · ${slide.title}`}
                  aria-pressed={selectedId === slide.id}
                  className={styles.card}
                  data-testid={`outline-slide-${index + 1}`}
                  key={slide.id}
                  type="button"
                  onClick={() => setSelectedId(slide.id)}
                >
                  <span className={styles.number}>{String(index + 1).padStart(2, '0')}</span>
                  <strong className={styles.title}>{slide.title}</strong>
                  <span className={styles.claim}>
                    {slide.claim || slide.keyPoints[0] || slide.objective}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <Drawer
          closeIcon={<X size={22} />}
          open={!!selected}
          title={selected ? `${String(selectedIndex + 1).padStart(2, '0')}` : ''}
          width={400}
          onClose={() => setSelectedId(null)}
        >
          {selected && (
            <div className={styles.details}>
              <Input.TextArea
                autoSize
                aria-label={`第 ${selectedIndex + 1} 页标题`}
                disabled={locked}
                value={selected.title}
                onChange={(e) => handleUpdateTitle(selectedIndex, e.target.value)}
              />
              <Flexbox horizontal gap={8}>
                <Button
                  aria-label={`上移第 ${selectedIndex + 1} 页`}
                  disabled={locked || selectedIndex === 0}
                  icon={<Icon icon={ArrowUp} size={19} />}
                  type="text"
                  onClick={() => handleMoveSlide(selectedIndex, -1)}
                />
                <Button
                  aria-label={`下移第 ${selectedIndex + 1} 页`}
                  disabled={locked || selectedIndex === slides.length - 1}
                  icon={<Icon icon={ArrowDown} size={19} />}
                  type="text"
                  onClick={() => handleMoveSlide(selectedIndex, 1)}
                />
                <Button
                  aria-label={`复制第 ${selectedIndex + 1} 页`}
                  disabled={locked}
                  icon={<Icon icon={Copy} size={19} />}
                  type="text"
                  onClick={() => handleDuplicateSlide(selectedIndex)}
                />
                <Button
                  aria-label={`优化第 ${selectedIndex + 1} 页`}
                  disabled={locked}
                  icon={<Icon icon={Sparkles} size={21} />}
                  loading={aiBusy === selectedIndex}
                  type="text"
                  onClick={() => void handleAiRewriteSlide(selectedIndex)}
                />
                <Button
                  aria-label={`删除第 ${selectedIndex + 1} 页`}
                  disabled={locked || slides.length <= 1}
                  icon={<Icon icon={Trash2} size={19} />}
                  type="text"
                  onClick={() => handleDeleteSlide(selectedIndex)}
                />
              </Flexbox>
              <label>
                {t('presentationStoryboard.claim')}
                <Input.TextArea
                  autoSize
                  aria-label={`第 ${selectedIndex + 1} 页核心结论`}
                  disabled={locked}
                  value={selected.claim ?? selected.keyPoints[0]}
                  onChange={(e) => handleUpdateClaim(selectedIndex, e.target.value)}
                />
              </label>
              <div>
                <span className={styles.label}>{t('presentationStoryboard.points')}</span>
                {selected.keyPoints.map((point, i) => (
                  <Flexbox horizontal align="center" gap={4} key={i}>
                    <Input.TextArea
                      autoSize
                      aria-label={`第 ${selectedIndex + 1} 页要点 ${i + 1}`}
                      disabled={locked}
                      value={point}
                      onChange={(e) => handleUpdatePoint(selectedIndex, i, e.target.value)}
                    />
                    <Button
                      aria-label={`删除第 ${selectedIndex + 1} 页要点 ${i + 1}`}
                      disabled={locked}
                      icon={<Icon icon={Minus} size={16} />}
                      type="text"
                      onClick={() => handleRemovePoint(selectedIndex, i)}
                    />
                  </Flexbox>
                ))}
                <Button
                  aria-label={`为第 ${selectedIndex + 1} 页添加要点`}
                  disabled={locked}
                  icon={<Icon icon={Plus} size={18} />}
                  type="text"
                  onClick={() => handleAddPoint(selectedIndex)}
                />
              </div>
              <label>
                {t('presentationStoryboard.visual')}
                <Input.TextArea
                  autoSize
                  aria-label={`第 ${selectedIndex + 1} 页视觉建议`}
                  disabled={locked}
                  value={selected.visualSuggestion}
                  onChange={(e) => handleUpdateVisual(selectedIndex, e.target.value)}
                />
              </label>
              <details>
                <summary>{t('presentationStoryboard.notes')}</summary>
                <Input.TextArea
                  autoSize
                  aria-label={`第 ${selectedIndex + 1} 页演讲备注`}
                  disabled={locked}
                  value={selected.speakerNotes}
                  onChange={(e) => handleUpdateSpeakerNotes(selectedIndex, e.target.value)}
                />
              </details>
            </div>
          )}
        </Drawer>
      </section>
    );
  },
);

OutlineWorkspace.displayName = 'OutlineWorkspace';

export default OutlineWorkspace;
