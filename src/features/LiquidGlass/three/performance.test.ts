import { describe, expect, it } from 'vitest';

import { captureDelay, GlassFrameBudget, sharedPixelRatio } from './performance';

describe('glass interaction budgets', () => {
  it('reduces resolution under GPU pressure without adding a player frame-rate cap', () => {
    const budget = new GlassFrameBudget();
    for (let index = 0; index < 100; index++) budget.recordCapsule(20);
    expect(budget.capsulePixels()).toBe(18_000);
    expect(budget.sharedPixels()).toBe(180_000);
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
    expect(budget.sharedPixels()).toBe(144_000);
  });

  it('keeps a 400×900 sidebar at CSS resolution at rest and at least 0.75 while moving', () => {
    expect(sharedPixelRatio(400 * 900, 180_000, false, 2)).toBe(1);
    expect(sharedPixelRatio(400 * 900, 36_000, true, 2)).toBe(0.75);
    expect(sharedPixelRatio(100 * 100, 180_000, true, 2)).toBe(2);
  });

  it('allows cheap content captures at refresh cadence and bounds slower work', () => {
    expect(captureDelay(0, 3)).toBeCloseTo(1000 / 60);
    expect(captureDelay(20, 3)).toBe(0);
    expect(captureDelay(0, 1000)).toBe(100);
    expect(captureDelay(200, 1000)).toBe(0);
  });
});
