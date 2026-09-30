import { contentLayout } from './content-layout';

/** A figure shorter than this cannot carry a geometric teaching point. */
export const READABLE_FIGURE_PX = 180;
const FORMULA_GAP_PX = 12;

/** Vertical room under the title band, in the 960-wide canvas. */
export function contentBandHeight(aspectRatio = '16:9'): number {
  return contentLayout(undefined, aspectRatio).height;
}

/**
 * Formulas keep their measured height. A required figure needs a readable band
 * of its own. When both do not fit, the page splits; neither is shrunk.
 */
export function formulasFitWithFigure(
  formulaHeights: readonly number[],
  aspectRatio = '16:9',
  figurePx = READABLE_FIGURE_PX,
): boolean {
  const gaps = Math.max(0, formulaHeights.length - 1) * FORMULA_GAP_PX;
  const used = formulaHeights.reduce((sum, height) => sum + height, 0) + gaps;
  return used + figurePx <= contentBandHeight(aspectRatio);
}
