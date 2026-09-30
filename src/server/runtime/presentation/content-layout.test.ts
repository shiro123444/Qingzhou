import { describe, expect, it } from 'vitest';

import { contentLayout } from './content-layout';
import { fitFormula, measureFormula, renderFormula } from './formula-renderer';

describe('stage-aware formula layout', () => {
  const latex =
    'L(w + \\Delta w) \\approx L(w) + \\nabla L(w)^T \\Delta w + \\frac{1}{2} \\Delta w^T H(w) \\Delta w';
  it('replays the failing Taylor expression into the boardwork budget without shrinking', async () => {
    expect((await measureFormula({ latex })).minRectWidth).toBe(653);
    const bounds = contentLayout('right-third');
    expect(bounds.width).toBe(544);
    const fitted = await fitFormula({ latex }, bounds);
    expect(fitted.latex).toContain('aligned');
    expect(fitted.measurement.minRectWidth).toBeLessThanOrEqual(544);
    expect(fitted.measurement.fontSize).toBe(28);
    const unwrapped = fitted.latex.replaceAll(
      /\\begin\{aligned\}|\\end\{aligned\}|&|\\\\|\s/gu,
      '',
    );
    expect(unwrapped).toBe(latex.replaceAll(/\s/gu, ''));
    await expect(
      renderFormula({
        id: 'taylor-expansion',
        kind: 'formula',
        latex: fitted.latex,
        display: true,
        fontSize: 28,
        color: '#172554',
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      }),
    ).resolves.toContain('<path');
  });
  it('keeps short formula sources and explicit font sizes', async () => {
    const result = await fitFormula({ latex: 'x^2+y^2', fontSize: 32 }, contentLayout());
    expect(result.latex).toBe('x^2+y^2');
    expect(result.measurement.fontSize).toBe(32);
  });
  it('does not split nested expressions or silently remove content when there is no room', async () => {
    await expect(
      fitFormula({ latex: '\\frac{a+b}{c-d}' }, { width: 2, height: 3 }),
    ).rejects.toThrow('this stage');
  });
});
