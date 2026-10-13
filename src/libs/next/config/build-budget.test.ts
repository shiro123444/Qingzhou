import { describe, expect, it } from 'vitest';

import { getBuildBudget } from './build-budget';

describe('compact compiler budgets', () => {
  it('does not reinterpret the deployment runtime profile as a build limit', () => {
    expect(getBuildBudget('')).toEqual({});
    expect(() => getBuildBudget('custom')).toThrow('QINGZHOU_BUILD_PROFILE');
  });
  it('bounds page workers and enables the compact compiler memory optimizations', () => {
    expect(getBuildBudget('4c4g')).toEqual({
      cpus: 2,
      staticGenerationMaxConcurrency: 2,
      webpackBuildWorker: true,
      webpackMemoryOptimizations: true,
    });
    expect(getBuildBudget('8c8g')).toMatchObject({ cpus: 4 });
  });
});
