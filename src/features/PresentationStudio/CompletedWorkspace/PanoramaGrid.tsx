import { Tag } from '@lobehub/ui';
import { memo } from 'react';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import type { PresentationSlotState } from '../store/presentationStore';
import { revealSrcsForSlide } from './slidePaint';
import SlidePaintOverlay from './SlidePaintOverlay';
import { styles } from './style';

export interface PanoramaGridProps {
  onSelectSlide: (artifactId: string) => void;
  painting?: boolean;
  paintingSlideNumber?: number;
  paintInterrupted?: boolean;
  resolveArtifactUri?: (artifactId: string) => string | undefined;
  selectedArtifactId: string | null;
  slides: ArtifactSnapshot[];
  slots?: PresentationSlotState[];
}

export const PanoramaGrid = memo<PanoramaGridProps>(
  ({
    onSelectSlide,
    paintInterrupted = false,
    painting = false,
    paintingSlideNumber,
    resolveArtifactUri,
    selectedArtifactId,
    slides,
    slots = [],
  }) => {
    return (
      <section
        aria-label="全景灯箱网格"
        className={styles.bentoGrid}
        data-testid="presentation-bento-grid"
      >
        {slides.map((slide, index) => {
          const slidePainting =
            painting && (!paintingSlideNumber || paintingSlideNumber === index + 1);
          const isSelected = slide.artifactId === selectedArtifactId;
          const pageNum = String(index + 1).padStart(2, '0');
          const title =
            (typeof slide.metadata?.title === 'string' && slide.metadata.title.trim()) ||
            slide.name ||
            `第 ${index + 1} 页`;

          return (
            <div
              aria-label={`第 ${index + 1} 页：${title}`}
              aria-selected={isSelected}
              data-selected={isSelected ? 'true' : 'false'}
              data-testid={`bento-card-${slide.artifactId}`}
              key={slide.artifactId}
              role="button"
              tabIndex={0}
              className={
                isSelected ? `${styles.bentoCard} ${styles.bentoCardSelected}` : styles.bentoCard
              }
              onClick={() => onSelectSlide(slide.artifactId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectSlide(slide.artifactId);
                }
              }}
            >
              <div className={styles.bentoFrame} data-painting={slidePainting ? 'true' : 'false'}>
                {slide.uri && slide.status === 'ready' ? (
                  <img alt={title} className={styles.bentoImage} loading="lazy" src={slide.uri} />
                ) : (
                  <div style={{ color: 'rgba(255, 255, 255, 0.45)', fontSize: 11 }}>
                    SVG 暂不可用
                  </div>
                )}
                <SlidePaintOverlay
                  active={slidePainting}
                  interrupted={paintInterrupted}
                  revealSrcs={revealSrcsForSlide(slide, slots, resolveArtifactUri)}
                />
              </div>

              <div className={styles.bentoMeta}>
                <Tag bordered={false} color={isSelected ? 'blue' : 'default'} size="small">
                  {pageNum}
                </Tag>
                <span className={styles.bentoTitle} title={title}>
                  {title}
                </span>
              </div>
            </div>
          );
        })}
      </section>
    );
  },
);

PanoramaGrid.displayName = 'PanoramaGrid';

export default PanoramaGrid;
