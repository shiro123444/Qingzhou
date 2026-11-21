import { Flexbox } from '@lobehub/ui';
import { Layers } from 'lucide-react';
import { memo, useCallback } from 'react';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface SlideNavigatorProps {
  className?: string;
  /** Compact completed-editor rail: thumbnails and page numbers only. */
  compact?: boolean;
  hasSelection: boolean;
  onSelect: (artifactId: string) => void;
  selectedArtifactId: string | null;
  /** Ready SVG slide artifacts, ordered. */
  slides: ArtifactSnapshot[];
}

/**
 * Thumbnail navigator for the ready slides of the selected job. Failed or
 * pending artifacts stay visible, greyed out and non-selectable — never
 * silently hidden.
 */
export const SlideNavigator = memo<SlideNavigatorProps>(
  ({ className, compact = false, hasSelection, onSelect, selectedArtifactId, slides }) => {
    const selectable = slides.filter((slide) => slide.status === 'ready');
    const tabStop =
      selectable.find((slide) => slide.artifactId === selectedArtifactId) ?? selectable[0];

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (selectable.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
        const nextIndex = selectable.findIndex((slide) => slide.artifactId === selectedArtifactId);

        let targetIndex = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          targetIndex = nextIndex < 0 ? 0 : (nextIndex + 1) % selectable.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          targetIndex =
            nextIndex < 0
              ? selectable.length - 1
              : (nextIndex - 1 + selectable.length) % selectable.length;
        }

        if (event.key === 'Home') targetIndex = 0;
        if (event.key === 'End') targetIndex = selectable.length - 1;
        if (targetIndex >= 0) {
          event.preventDefault();
          event.currentTarget
            .querySelectorAll<HTMLElement>('[role=option][data-ready=true]')
            [targetIndex]?.focus({ preventScroll: compact });
          onSelect(selectable[targetIndex].artifactId);
        }
      },
      [compact, onSelect, selectable, selectedArtifactId],
    );

    return (
      <section
        aria-label="Slide navigator"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-compact={compact ? 'true' : undefined}
        data-testid="slide-navigator"
      >
        {!compact && (
          <Flexbox horizontal align="center" gap={8}>
            <Layers size={14} style={{ opacity: 0.6 }} />
            <span className={styles.title}>
              幻灯片列表
              <span style={{ display: 'none' }}>Slides</span>
            </span>
          </Flexbox>
        )}

        {slides.length === 0 ? (
          <div className={styles.empty} data-testid="slide-navigator-empty">
            {hasSelection ? (
              <span>
                该任务暂无可用幻灯片数据。
                <span style={{ display: 'none' }}>No slides available for this job.</span>
              </span>
            ) : (
              <span>
                请选择已完成任务以查看幻灯片缩略图。
                <span style={{ display: 'none' }}>
                  Select a completed job to see slide thumbnails.
                </span>
              </span>
            )}
          </div>
        ) : (
          <div
            aria-label="Slide thumbnails"
            aria-orientation="vertical"
            className={styles.grid}
            data-testid="slide-navigator-grid"
            role="listbox"
            tabIndex={tabStop ? -1 : 0}
            onKeyDown={handleKeyDown}
          >
            {slides.map((slide, index) => {
              const ready = slide.status === 'ready';
              const isSelected = ready && slide.artifactId === selectedArtifactId;
              return (
                <div
                  aria-disabled={!ready}
                  aria-label={`Slide ${index + 1}: ${slide.name ?? slide.artifactId}, status: ${slide.status}${isSelected ? ', selected' : ''}`}
                  aria-selected={isSelected}
                  className={styles.thumb}
                  data-ready={ready ? 'true' : 'false'}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-testid={`slide-navigator-item-${slide.artifactId}`}
                  key={slide.artifactId}
                  role="option"
                  tabIndex={slide === tabStop ? 0 : -1}
                  title={
                    compact
                      ? String(slide.metadata?.title ?? slide.name ?? `Slide ${index + 1}`)
                      : undefined
                  }
                  onClick={() => {
                    if (ready) onSelect(slide.artifactId);
                  }}
                  onKeyDown={(event) => {
                    if (!ready || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    onSelect(slide.artifactId);
                  }}
                >
                  <div className={styles.thumbFrame}>
                    {slide.uri && ready ? (
                      <img
                        alt={slide.name ?? `Slide ${index + 1}`}
                        className={styles.thumbImage}
                        loading="lazy"
                        src={slide.uri}
                      />
                    ) : (
                      <div className={styles.thumbFallback}>SVG 暂不可用</div>
                    )}
                  </div>
                  <div className={styles.thumbMeta}>
                    <span>
                      {compact ? (
                        String(index + 1).padStart(2, '0')
                      ) : (
                        <>
                          第 {index + 1} 页
                          <span style={{ display: 'none' }}>Slide {index + 1}</span>
                        </>
                      )}
                    </span>
                    {(!compact || !ready) && (
                      <span className={styles.thumbStatus}>{slide.status}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  },
);

SlideNavigator.displayName = 'SlideNavigator';

export default SlideNavigator;
