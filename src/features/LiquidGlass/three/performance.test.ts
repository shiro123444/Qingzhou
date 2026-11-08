import { describe, expect, it } from 'vitest';

import { captureDelay, GlassFrameBudget } from './performance';

describe('glass interaction budgets', () => {
  it('reduces resolution under GPU pressure without adding a player frame-rate cap', () => {
    const budget = new GlassFrameBudget();
    for (let index = 0; index < 100; index++) budget.recordCapsule(20);
    expect(budget.capsulePixels()).toBe(18_000);
    expect(budget.sharedPixels()).toBe(35_000);
    for (let index = 0; index < 60; index++) budget.recordCapsule(2);
    expect(budget.capsulePixels()).toBe(22_500);
  });

  it('defers costly secondary panes during input, but presents fresh content and recovers at rest', () => {
    const budget = new GlassFrameBudget();
    budget.recordShared(0, 16);
    expect(budget.shouldDrawShared(17, true, false)).toBe(false);
    expect(budget.shouldDrawShared(17, true, true)).toBe(true);
    expect(budget.shouldDrawShared(17, false, false)).toBe(true);
    expect(budget.shouldDrawShared(100, true, false)).toBe(true);
    expect(budget.sharedPixels()).toBe(28_000);
  });

  it('allows cheap content captures at refresh cadence and bounds slower work', () => {
    expect(captureDelay(0, 3)).toBeCloseTo(1000 / 60);
    expect(captureDelay(20, 3)).toBe(0);
    expect(captureDelay(0, 1000)).toBe(100);
    expect(captureDelay(200, 1000)).toBe(0);
  });
});
