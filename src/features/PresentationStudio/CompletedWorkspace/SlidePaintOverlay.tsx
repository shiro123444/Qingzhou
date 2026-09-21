import { Paintbrush } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { memo, useMemo } from 'react';

import { styles } from './style';

export interface SlidePaintOverlayProps {
  active: boolean;
  interrupted?: boolean;
  revealSrcs?: string[];
}

export const SlidePaintOverlay = memo<SlidePaintOverlayProps>(
  ({ active, interrupted = false, revealSrcs = [] }) => {
    const reducedMotion = useReducedMotion();

    const liveReveals = useMemo(() => {
      return [...new Set(revealSrcs)].slice(-4);
    }, [revealSrcs]);

    if (!active) return null;

    return (
      <div aria-hidden className={styles.paintOverlay} data-testid="slide-paint-overlay">
        <div className={styles.paintFrost} />
        <svg className={styles.paintStroke} preserveAspectRatio="none" viewBox="0 0 960 540">
          <motion.path
            d="M 168 346 C 326 246, 488 322, 684 214 C 742 182, 790 178, 824 188"
            fill="none"
            initial={{ pathLength: 0, opacity: 0 }}
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="12"
            animate={
              reducedMotion
                ? { pathLength: 0.72, opacity: 0.28 }
                : interrupted
                  ? { pathLength: 0.72, opacity: 0.28 }
                  : { pathLength: [0, 0.72, 1], opacity: [0, 0.34, 0] }
            }
            transition={{
              duration: 3.6,
              times: [0, 0.72, 1],
              repeat: Infinity,
              repeatDelay: 0.45,
              ease: [0.45, 0, 0.2, 1],
            }}
          />
        </svg>
        <motion.div
          className={styles.paintBrushMotion}
          data-testid="paint-brush"
          initial={{ left: '17%', opacity: 0, top: '64%' }}
          animate={
            reducedMotion || interrupted
              ? { left: '70%', opacity: 0.9, top: '39%' }
              : {
                  left: ['17%', '34%', '51%', '70%', '84%'],
                  opacity: [0, 1, 1, 1, 0],
                  top: ['64%', '50%', '59%', '39%', '35%'],
                }
          }
          transition={{
            duration: 3.6,
            times: [0, 0.22, 0.46, 0.72, 1],
            repeat: Infinity,
            repeatDelay: 0.45,
            ease: [0.45, 0, 0.2, 1],
          }}
        >
          <span className={styles.paintBrushIcon}>
            <Paintbrush size={20} strokeWidth={1.7} />
          </span>
        </motion.div>
        <span className={styles.paintCaption}>{interrupted ? '已保留，等待续绘' : '正在绘制'}</span>
        <div className={styles.paintAssets}>
          {liveReveals.map((src, index) => (
            <img alt="" key={src} src={src} style={{ animationDelay: `${index * 180}ms` }} />
          ))}
        </div>
      </div>
    );
  },
);

SlidePaintOverlay.displayName = 'SlidePaintOverlay';

export default SlidePaintOverlay;
