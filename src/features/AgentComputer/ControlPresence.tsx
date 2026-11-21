import { motion, useReducedMotion, useSpring } from 'motion/react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { springs } from '@/features/GlassMotion/springs';
import { WeightWave } from '@/features/GlassMotion/WeightWave';

import { styles } from './style';

export type ComputerPresence =
  'off' | 'viewing' | 'human' | 'busy' | 'sleeping' | 'unknown' | 'unavailable';

/** Control stays a server-confirmed state, even while the visual treatment changes. */
export function ControlPresence({ state }: { state: ComputerPresence }) {
  const { t } = useTranslation('chat');
  const reduced = useReducedMotion();
  const rise = useSpring(0, springs.soft);
  useEffect(() => {
    if (reduced) return;
    rise.jump(16);
    rise.set(0);
  }, [state, reduced, rise]);
  return (
    <header className={styles.presence} data-computer-presence={state}>
      <div className={styles.presenceCopy}>
        <div aria-live="polite" className={styles.headlineSlot}>
          <motion.h2 className={styles.headline} style={{ y: reduced ? 0 : rise }}>
            <WeightWave weight={650}>{t(`computer.workbench.headline.${state}`)}</WeightWave>
          </motion.h2>
        </div>
      </div>
    </header>
  );
}

/** A code-native glass object; no extra image, model or canvas is loaded for an empty computer. */
export function GlassComputer() {
  return (
    <div aria-hidden className={styles.computerSculpture}>
      <div className={styles.lightField} />
      <div className={styles.sculptureMonitor}>
        <div className={styles.sculptureScreen}>
          <span className={styles.screenCursor} />
        </div>
        <div className={styles.sculptureStem} />
        <div className={styles.sculptureFoot} />
      </div>
    </div>
  );
}
