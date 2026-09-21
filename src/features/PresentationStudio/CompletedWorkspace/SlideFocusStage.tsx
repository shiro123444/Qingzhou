import { Button, Icon } from '@lobehub/ui';
import { Tooltip } from 'antd';
import {
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  ImageIcon,
  Layers,
  MessageCircle,
  MessageSquarePlus,
} from 'lucide-react';
import { type CSSProperties, memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArtifactSnapshot,
  PresentationMessageInput,
} from '../../../../packages/runtime-contracts/src/index';
import { SlideAnnotation } from '../annotation/SlideAnnotation';
import SlidePaintOverlay from './SlidePaintOverlay';
import { styles } from './style';

export interface SlideFocusStageProps {
  conversationOpen?: boolean;
  currentIndex: number;
  jobId?: string;
  onNext: () => void;
  onOpenDrawer: () => void;
  onPrev: () => void;
  onSendMessage?: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  onToggleConversation?: () => void;
  painting?: boolean;
  paintInterrupted?: boolean;
  revealSrcs?: string[];
  selectedSlide: ArtifactSnapshot | null;
  totalSlides: number;
  versionId?: string;
}

const getSlideStatusZh = (status?: string): string => {
  switch (status) {
    case 'ready': {
      return '已就绪';
    }
    case 'generating': {
      return '生成中';
    }
    case 'failed': {
      return '生成失败';
    }
    case 'cancelled': {
      return '已取消';
    }
    case 'pending':
    default: {
      return '排队中';
    }
  }
};

export const SlideFocusStage = memo<SlideFocusStageProps>(
  ({
    conversationOpen = false,
    currentIndex,
    jobId,
    onNext,
    onOpenDrawer,
    onPrev,
    onSendMessage,
    onToggleConversation,
    paintInterrupted = false,
    painting = false,
    revealSrcs,
    selectedSlide,
    totalSlides,
    versionId,
  }) => {
    const { t } = useTranslation('common');
    const [annotating, setAnnotating] = useState(false);
    useEffect(() => setAnnotating(false), [currentIndex]);
    const aspectRatio = selectedSlide?.metadata?.aspectRatio === '4:3' ? '4:3' : '16:9';
    const [slideAw, slideAh] = aspectRatio === '4:3' ? [4, 3] : [16, 9];
    const ready = selectedSlide?.status === 'ready' && Boolean(selectedSlide?.uri);

    const pagePillText =
      totalSlides > 0
        ? `${String(currentIndex + 1).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`
        : '00 / 00';

    // Keyboard navigation (ArrowLeft/ArrowRight)
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        ) {
          return;
        }

        if (e.key === 'ArrowLeft' && currentIndex > 0) {
          e.preventDefault();
          onPrev();
        } else if (e.key === 'ArrowRight' && currentIndex < totalSlides - 1) {
          e.preventDefault();
          onNext();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentIndex, onNext, onPrev, totalSlides]);

    return (
      <section aria-label="幻灯片单页预览" className={styles.stageArea} data-testid="slide-preview">
        <div className={styles.focusCanvas}>
          <div
            aria-label={`第 ${currentIndex + 1} 页 ${aspectRatio} 大预览`}
            className={styles.focusFrame169}
            data-painting={painting ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            style={
              {
                '--slide-ah': slideAh,
                '--slide-aw': slideAw,
              } as CSSProperties
            }
            onClick={() => {
              if (!annotating) onOpenDrawer();
            }}
            onKeyDown={(e) => {
              if (annotating || e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenDrawer();
              }
            }}
          >
            {ready ? (
              <img
                alt={selectedSlide?.name ?? `第 ${currentIndex + 1} 页`}
                className={styles.focusImage}
                data-testid="slide-preview-image"
                src={selectedSlide?.uri}
              />
            ) : (
              <div className={styles.focusEmpty} data-testid="slide-preview-empty">
                <Icon icon={selectedSlide ? ImageIcon : FileQuestion} size={32} />
                <span>
                  {selectedSlide
                    ? `产物状态为【${getSlideStatusZh(selectedSlide.status)}】— 暂无可用预览。`
                    : '请选择已就绪的幻灯片以预览 SVG 画布。'}
                </span>
              </div>
            )}

            <SlidePaintOverlay
              active={painting}
              interrupted={paintInterrupted}
              revealSrcs={revealSrcs}
            />

            {annotating && ready && jobId && versionId && onSendMessage && (
              <SlideAnnotation
                jobId={jobId}
                page={currentIndex + 1}
                versionId={versionId}
                onClose={() => setAnnotating(false)}
                onSend={onSendMessage}
              />
            )}
            {!annotating && (
              <div className={styles.hoverCue} data-role="hover-cue">
                <Icon icon={Layers} size={12} />
                <span>查看资产</span>
              </div>
            )}
          </div>
        </div>

        <nav
          aria-label="幻灯片舞台指挥条"
          className={styles.commandBar}
          data-testid="slide-command-bar"
        >
          {onSendMessage && (
            <Tooltip title={annotating ? '退出标注' : '标注修改'}>
              <Button
                aria-label={annotating ? '退出标注' : '标注修改'}
                aria-pressed={annotating}
                className={styles.iconButton}
                disabled={!ready || !versionId}
                icon={<Icon icon={MessageSquarePlus} size={23} />}
                type={annotating ? 'primary' : 'text'}
                onClick={() => setAnnotating(!annotating)}
              />
            </Tooltip>
          )}
          {onToggleConversation && (
            <button
              aria-expanded={conversationOpen}
              aria-pressed={conversationOpen}
              className={styles.conversationTrigger}
              data-testid="presentation-conversation-trigger"
              type="button"
              onClick={onToggleConversation}
            >
              <MessageCircle aria-hidden size={18} strokeWidth={1.6} />
              {t('presentationConversation.open')}
            </button>
          )}
          <div aria-label="幻灯片分页导航" className={styles.paginatorGroup}>
            <Tooltip title="上一页">
              <Button
                aria-label="上一页"
                className={styles.iconButton}
                disabled={currentIndex <= 0}
                icon={<Icon aria-hidden icon={ChevronLeft} size={22} />}
                type="text"
                onClick={onPrev}
              />
            </Tooltip>

            <span className={styles.pageCounter} data-testid="slide-page-counter">
              {pagePillText}
            </span>

            <Tooltip title="下一页">
              <Button
                aria-label="下一页"
                className={styles.iconButton}
                disabled={currentIndex >= totalSlides - 1}
                icon={<Icon aria-hidden icon={ChevronRight} size={22} />}
                type="text"
                onClick={onNext}
              />
            </Tooltip>
          </div>
        </nav>
      </section>
    );
  },
);

SlideFocusStage.displayName = 'SlideFocusStage';

export default SlideFocusStage;
