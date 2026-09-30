import { describe, expect, it } from 'vitest';

import { contentBandHeight, formulasFitWithFigure, READABLE_FIGURE_PX } from './page-budget';

describe('page budget', () => {
  it('keeps a short derivation and a readable figure on one page', () => {
    expect(formulasFitWithFigure([40, 40])).toBe(true);
  });

  it('splits when measured formulas leave no readable figure band', () => {
    const heights = [91, 91, 38, 36];
    expect(
      heights.reduce((sum, height) => sum + height, 0) + 36 + READABLE_FIGURE_PX,
    ).toBeGreaterThan(contentBandHeight());
    expect(formulasFitWithFigure(heights)).toBe(false);
  });
});
