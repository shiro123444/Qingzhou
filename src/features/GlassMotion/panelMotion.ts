import { spring } from 'motion';
import type { CSSProperties } from 'react';

import { springs } from './springs';

// The draggable navigation uses this same spring in JS. Sample it once for CSS-sized panels.
export const panelResizeTiming = String(spring({ keyframes: [0, 1], ...springs.soft }));
export const panelMotionStyle = {
  '--qz-panel-resize': panelResizeTiming,
} as CSSProperties;
