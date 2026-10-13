import { memo, useId } from 'react';

import { styles } from './style';

export interface SlideGenerationOverlayProps {
  active: boolean;
  compact?: boolean;
  hasPreview?: boolean;
  interrupted?: boolean;
}

/** A decorative watercolor scene, independent of actual job progress. */
export const SlideGenerationOverlay = memo<SlideGenerationOverlayProps>(
  ({ active, compact = false, hasPreview = true, interrupted = false }) => {
    const id = useId().replaceAll(':', '');
    if (!active) return null;

    return (
      <div
        className={styles.generationOverlay}
        data-compact={compact}
        data-empty={!hasPreview}
        data-state={interrupted ? 'interrupted' : 'running'}
        data-testid="slide-generation-overlay"
      >
        {!compact && (
          <svg
            aria-hidden
            className={styles.generationWatercolor}
            focusable="false"
            viewBox="0 0 300 220"
          >
            <defs>
              <filter height="120%" id={`watercolor-${id}`} width="120%" x="-10%" y="-10%">
                <feTurbulence baseFrequency="0.065" numOctaves="2" result="paper" seed="7" />
                <feDisplacementMap in="SourceGraphic" in2="paper" scale="4" />
              </filter>
              <clipPath id={`paper-${id}`}>
                <rect height="220" rx="18" width="300" />
              </clipPath>
            </defs>
            <g clipPath={`url(#paper-${id})`}>
              <rect className={styles.generationPaper} height="220" width="300" />
              <g filter={`url(#watercolor-${id})`}>
                <g className={styles.generationSky}>
                  <path
                    d="M-14 32Q60-6 142 24T318 10V130Q239 101 153 125T-14 109Z"
                    fill="#adcfcf"
                    opacity=".42"
                  />
                  <path
                    d="M-10 68Q56 37 125 61T316 47V112Q216 145 121 107T-10 128Z"
                    fill="#cee1d6"
                    opacity=".5"
                  />
                  <path
                    d="M24 57Q47 35 72 49T119 49Q116 74 80 73T24 57M169 38Q186 19 210 32T272 31Q274 50 240 53T169 38"
                    fill="#e4c89e"
                    opacity=".45"
                  />
                  <path d="M-5 119Q38 87 78 106T147 100L147 142H-5Z" fill="#a7c2ad" opacity=".35" />
                  <path d="M184 119Q227 83 252 99T305 92V146H184Z" fill="#87b5ae" opacity=".3" />
                </g>
                <g className={styles.generationRiver}>
                  <path d="M-12 136Q69 111 151 135T315 125V226H-12Z" fill="#8bbcb9" opacity=".48" />
                  <path d="M-10 158Q64 137 141 158T314 147V224H-10Z" fill="#6ea6a9" opacity=".28" />
                  <path
                    d="M12 167Q80 154 135 168M105 197Q187 180 271 194M189 153Q244 144 288 157"
                    fill="none"
                    opacity=".45"
                    stroke="#e1efdf"
                    strokeLinecap="round"
                    strokeWidth="7"
                  />
                  <path d="M0 210Q30 163 67 172T107 221Z" fill="#779f8b" opacity=".5" />
                  <path d="M246 228Q266 183 305 176V228Z" fill="#6f9a87" opacity=".45" />
                </g>
                <g className={styles.generationBoat}>
                  <path
                    d="M126 150Q155 157 197 147L183 166Q158 175 138 165Z"
                    fill="#477b77"
                    opacity=".85"
                  />
                  <path
                    d="M159 72L158 150"
                    fill="none"
                    stroke="#7f967e"
                    strokeLinecap="round"
                    strokeWidth="3"
                  />
                  <path d="M153 77Q125 103 125 141L151 146Z" fill="#f2e9d6" opacity=".96" />
                  <path d="M164 83Q192 109 188 140L163 146Z" fill="#d2dfcc" opacity=".95" />
                  <path
                    d="M149 166Q165 177 184 169"
                    fill="none"
                    opacity=".45"
                    stroke="#dbe9d4"
                    strokeLinecap="round"
                    strokeWidth="5"
                  />
                </g>
                <g
                  className={styles.generationReeds}
                  fill="none"
                  opacity=".5"
                  stroke="#699480"
                  strokeLinecap="round"
                >
                  <path
                    d="M17 192Q8 155 13 141M27 198Q29 161 25 155M36 194Q36 172 43 163M282 212Q273 182 276 164M291 203Q296 177 290 170"
                    strokeWidth="3"
                  />
                  <path
                    d="M10 144L2 137M14 151L22 142M26 157L34 148M277 169L267 156M289 172L298 161"
                    strokeWidth="5"
                  />
                </g>
              </g>
            </g>
          </svg>
        )}
        <div className={styles.generationCopy}>
          <span className={styles.generationCaption}>
            {interrupted ? '已保留，等待继续' : '正在更新'}
          </span>
          {!compact && (
            <span className={styles.generationHint}>
              {hasPreview ? '已有预览仍可查看' : '清舟正将想法化为画面'}
            </span>
          )}
        </div>
      </div>
    );
  },
);

SlideGenerationOverlay.displayName = 'SlideGenerationOverlay';

export default SlideGenerationOverlay;
