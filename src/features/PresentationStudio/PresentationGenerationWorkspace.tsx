import { Button, Icon } from '@lobehub/ui';
import { Popover } from 'antd';
import { ChevronLeft, ChevronRight, CircleStop } from 'lucide-react';
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import ActivityHistory from './ActivityHistory';
import {
  type PresentationStreamStatus,
  usePresentationStudioStore,
} from './store/presentationStore';
import { styles } from './style';

interface PresentationGenerationWorkspaceProps {
  activityHistory?: { id: string; text: string }[];
  artifacts?: Record<string, ArtifactSnapshot>;
  busyState?: 'cancel' | 'retry' | null;
  job: PresentationJob;
  onCancel?: (jobId: string) => void;
  streamStatus?: PresentationStreamStatus | null;
  title?: string;
}

interface SlideCard {
  artifactId?: string;
  id: string;
  isCompleted: boolean;
  isPlaceholder?: boolean;
  label?: string;
  slideId?: string;
  slideIndex: number;
}

const SLOW_TITLE = '正在制作 PPT';
const PLACEHOLDER_CARDS: SlideCard[] = [0, 1, 2].map((index) => ({
  id: `planning-${index}`,
  isCompleted: false,
  isPlaceholder: true,
  slideIndex: index + 1,
}));

const SlowTypewriterTitle = memo(({ text }: { text: string }) => {
  const [displayedText, setDisplayedText] = useState(text);
  const [charIndex, setCharIndex] = useState(text.length);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setDisplayedText(text);
      setCharIndex(text.length);
      return;
    }
    setDisplayedText('');
    setCharIndex(0);
  }, [text]);

  useEffect(() => {
    if (charIndex >= text.length) return;
    const timer = setTimeout(() => {
      setDisplayedText(text.slice(0, charIndex + 1));
      setCharIndex((value) => value + 1);
    }, 150);
    return () => clearTimeout(timer);
  }, [charIndex, text]);

  return (
    <h2 aria-label={text} data-testid="presentation-generation-title">
      {displayedText}
    </h2>
  );
});
SlowTypewriterTitle.displayName = 'SlowTypewriterTitle';

const conciseActivityFor = (job: PresentationJob): string => {
  const record = job as unknown as Record<string, unknown>;
  // `message` often contains the original user prompt; never echo that into
  // the generation stage. Only backend-authored action fields are eligible.
  const activity = record.activity ?? record.lastAction ?? record.action;
  if (typeof activity === 'string' && activity.trim()) return activity.trim().slice(0, 80);

  const phase = typeof record.phase === 'string' ? record.phase.toLowerCase() : '';
  if (phase.includes('planner')) return '正在梳理内容与页面结构';
  if (phase.includes('worker')) return '正在生成页面与视觉素材';
  if (phase.includes('quality')) return '正在检查版式与内容';
  if (phase.includes('export')) return '正在生成可编辑文件';
  return job.state === 'queued' ? '正在准备创作环境' : '正在生成页面';
};

const circularOffset = (index: number, activeIndex: number, length: number): number => {
  let offset = index - activeIndex;
  if (length > 2 && offset > length / 2) offset -= length;
  if (length > 2 && offset < -length / 2) offset += length;
  return offset;
};

const PresentationGenerationWorkspace = memo<PresentationGenerationWorkspaceProps>(
  ({
    activityHistory,
    artifacts: propsArtifacts,
    busyState = null,
    job,
    onCancel,
    streamStatus = null,
  }) => {
    const storeArtifacts = usePresentationStudioStore((state) => state.artifacts);
    const allArtifacts = useMemo(
      () => propsArtifacts ?? storeArtifacts,
      [propsArtifacts, storeArtifacts],
    );
    const [activeIndex, setActiveIndex] = useState(0);
    const userNavigationUntil = useRef(0);

    const totalPages = useMemo(() => {
      const record = job as unknown as Record<string, unknown>;
      const total = record.totalSlides ?? record.slideCount;
      if (typeof total === 'number' && total > 0) return Math.floor(total);
      return job.artifactIds?.filter((id) => allArtifacts[id]?.type === 'svg').length || undefined;
    }, [allArtifacts, job]);

    const currentSlideIndex = useMemo(() => {
      const record = job as unknown as Record<string, unknown>;
      const current = record.currentSlide ?? record.activeSlide;
      return typeof current === 'number' && current > 0 ? Math.floor(current) : undefined;
    }, [job]);

    const cards = useMemo<SlideCard[]>(() => {
      const artifactIds = job.artifactIds ?? [];
      const slideArtifacts = artifactIds
        .map((artifactId) => allArtifacts[artifactId])
        .filter((artifact): artifact is ArtifactSnapshot => Boolean(artifact))
        .filter(
          (artifact) =>
            artifact.type === 'svg' ||
            (artifact.metadata?.slideId !== undefined && artifact.mimeType?.startsWith('image/')),
        );
      const knownBySlide = new Map<number, ArtifactSnapshot>();
      slideArtifacts.forEach((artifact, fallbackIndex) => {
        const metadata = artifact.metadata as Record<string, unknown> | undefined;
        const order = typeof metadata?.order === 'number' ? metadata.order : fallbackIndex + 1;
        knownBySlide.set(order === 0 ? 1 : order, artifact);
      });

      const count = totalPages ?? slideArtifacts.length;
      if (count === 0) return [];
      return Array.from({ length: count }, (_, index) => {
        const slideIndex = index + 1;
        const artifact = knownBySlide.get(slideIndex);
        const metadata = artifact?.metadata as Record<string, unknown> | undefined;
        const slideId =
          typeof metadata?.slideId === 'string' && metadata.slideId.trim()
            ? metadata.slideId.trim()
            : undefined;
        return {
          artifactId: artifact?.artifactId,
          id: slideId ?? artifact?.artifactId ?? `slide-${slideIndex}`,
          isCompleted: artifact?.status === 'ready',
          label:
            typeof metadata?.title === 'string' && metadata.title.trim()
              ? metadata.title.trim()
              : `第 ${slideIndex} 页`,
          slideId,
          slideIndex,
        };
      });
    }, [allArtifacts, job.artifactIds, totalPages]);

    const visualCards = cards.length > 0 ? cards : PLACEHOLDER_CARDS;
    const isPlanning = cards.length === 0;

    useEffect(() => {
      if (
        currentSlideIndex === undefined ||
        cards.length === 0 ||
        Date.now() < userNavigationUntil.current
      )
        return;
      setActiveIndex(Math.max(0, Math.min(cards.length - 1, currentSlideIndex - 1)));
    }, [cards.length, currentSlideIndex]);

    useEffect(() => {
      if (currentSlideIndex !== undefined || cards.length < 2) return;

      const timer = window.setInterval(() => {
        if (Date.now() < userNavigationUntil.current) return;
        setActiveIndex((index) => (index + 1) % cards.length);
      }, 2400);

      return () => window.clearInterval(timer);
    }, [cards.length, currentSlideIndex]);

    const move = useCallback(
      (direction: number) => {
        userNavigationUntil.current = Date.now() + 8000;
        setActiveIndex((index) => {
          const length = visualCards.length;
          return (index + direction + length) % length;
        });
      },
      [visualCards.length],
    );

    const selectCard = useCallback((index: number) => {
      userNavigationUntil.current = Date.now() + 8000;
      setActiveIndex(index);
    }, []);

    const handleWheel = useCallback(
      (event: React.WheelEvent<HTMLDivElement>) => {
        if (Math.abs(event.deltaY) < 8 && Math.abs(event.deltaX) < 8) return;
        event.preventDefault();
        move((event.deltaY || event.deltaX) > 0 ? 1 : -1);
      },
      [move],
    );

    const actionText = streamStatus === 'reconnecting' ? '正在恢复连接' : conciseActivityFor(job);
    const headline =
      actionText === '正在生成页面' || actionText === '正在准备创作环境' ? SLOW_TITLE : actionText;

    return (
      <section
        aria-busy
        aria-label="Presentation job status · 正在制作 PPT"
        className={styles.generationWorkspace}
        data-testid="presentation-generation-workspace"
      >
        <div aria-hidden="true" className={styles.generationGlow} />

        <div
          aria-label="幻灯片生成预览"
          className={styles.generationRail}
          data-testid="generation-cards-rail"
          onWheel={handleWheel}
        >
          <Button
            aria-label="上一张预览"
            className={styles.generationRailButton}
            icon={<Icon icon={ChevronLeft} size={20} />}
            type="text"
            onClick={() => move(-1)}
          />

          <div className={styles.generationCards}>
            {visualCards.map((card, index) => {
              const offset = circularOffset(index, activeIndex, visualCards.length);
              const isActive = offset === 0;
              const isGenerating =
                currentSlideIndex !== undefined
                  ? card.slideIndex === currentSlideIndex
                  : isPlanning && isActive;
              const artifact = card.artifactId ? allArtifacts[card.artifactId] : undefined;
              const extendedArtifact = artifact as
                | (ArtifactSnapshot & { content?: string; previewUri?: string })
                | undefined;
              const previewSrc =
                extendedArtifact?.previewUri ??
                artifact?.uri ??
                (extendedArtifact?.content?.startsWith('<svg')
                  ? `data:image/svg+xml;utf8,${encodeURIComponent(extendedArtifact.content)}`
                  : undefined);
              const cardStyle = {
                '--presentation-card-opacity': isActive ? 1 : Math.abs(offset) === 1 ? 0.46 : 0,
                '--presentation-card-scale': isActive ? 1 : Math.abs(offset) === 1 ? 0.78 : 0.66,
                '--presentation-card-x': `${offset * 58}%`,
                'zIndex': Math.max(0, 10 - Math.abs(offset)),
              } as CSSProperties;

              return (
                <Popover
                  key={`slide-slot-${card.slideIndex}`}
                  placement="top"
                  trigger={['hover', 'focus', 'click']}
                  content={
                    previewSrc ? (
                      <img
                        alt={`第 ${card.slideIndex} 页已完成部分`}
                        src={previewSrc}
                        style={{
                          display: 'block',
                          width: 'min(68vw, 720px)',
                          maxHeight: '60dvh',
                          objectFit: 'contain',
                          borderRadius: 12,
                        }}
                      />
                    ) : null
                  }
                >
                  <button
                    data-active={isActive ? 'true' : undefined}
                    data-slide-id={card.slideId}
                    key={`slide-slot-${card.slideIndex}`}
                    style={cardStyle}
                    type="button"
                    aria-label={
                      card.isPlaceholder
                        ? '等待生成页面'
                        : card.slideId
                          ? `第 ${card.slideIndex} 页正在制作 (${card.slideId})`
                          : `第 ${card.slideIndex} 页正在制作`
                    }
                    className={`${styles.generationCard} ${
                      isActive ? styles.generationCardActive : styles.generationCardAdjacent
                    } ${isGenerating ? styles.generationCardGenerating : ''} ${
                      card.isPlaceholder ? styles.generationCardWaiting : ''
                    }`}
                    data-testid={
                      card.isPlaceholder && index === 0
                        ? 'generation-waiting-card'
                        : `presentation-card-${card.id}`
                    }
                    onClick={() => selectCard(index)}
                  >
                    {previewSrc ? (
                      <img
                        alt={`第 ${card.slideIndex} 页预览`}
                        className={styles.generationCardPreview}
                        data-testid={`card-preview-${card.id}`}
                        src={previewSrc}
                      />
                    ) : (
                      <div aria-hidden="true" className={styles.generationCardSkeleton}>
                        <div className={styles.generationCardChrome} />
                        <div className={styles.generationCardLine} />
                        <div className={styles.generationCardLineShort} />
                      </div>
                    )}
                    {!card.isPlaceholder && !previewSrc && (
                      <div
                        aria-hidden="true"
                        className={styles.generationCardOverlay}
                        data-testid={`card-hover-preview-${card.id}`}
                      >
                        <span>{card.label}</span>
                        <small>{card.isCompleted ? '草稿已就绪' : '等待页面草稿'}</small>
                      </div>
                    )}
                  </button>
                </Popover>
              );
            })}
          </div>

          <Button
            aria-label="下一张预览"
            className={styles.generationRailButton}
            icon={<Icon icon={ChevronRight} size={20} />}
            type="text"
            onClick={() => move(1)}
          />
        </div>

        <div className={styles.generationCenter}>
          <SlowTypewriterTitle text={headline} />
          <ActivityHistory history={activityHistory}>
            <button
              aria-live="polite"
              className={styles.generationAction}
              data-testid="presentation-generation-action"
              style={{ border: 0, background: 'transparent', cursor: 'pointer' }}
              type="button"
            >
              {actionText}
            </button>
          </ActivityHistory>
          {onCancel && (
            <Button
              aria-label="Cancel presentation job"
              className={styles.generationCancel}
              disabled={busyState === 'cancel'}
              icon={<Icon icon={CircleStop} size={14} />}
              loading={busyState === 'cancel'}
              size="small"
              type="text"
              onClick={() => onCancel(job.jobId)}
            >
              取消
            </Button>
          )}
        </div>

        <div className={styles.srOnly} data-testid="presentation-generation-progress" role="status">
          <span data-testid="presentation-progress" />
          <span data-testid="job-stream-status">{streamStatus ?? 'unknown'}</span>
          <span data-testid="presentation-generation-stage">
            {(job as unknown as Record<string, unknown>).phase as string | undefined}
          </span>
          {currentSlideIndex !== undefined && totalPages !== undefined && (
            <span data-testid="presentation-generation-pages">
              第 {currentSlideIndex} / {totalPages} 页
            </span>
          )}
        </div>
      </section>
    );
  },
);

PresentationGenerationWorkspace.displayName = 'PresentationGenerationWorkspace';

export default PresentationGenerationWorkspace;
