import type { NextConfig } from 'next';

/** Webpack memory optimizations and page workers, separate from the server runtime budget. */
export function getBuildBudget(profile = process.env.QINGZHOU_BUILD_PROFILE) {
  if (!profile) return {};
  if (profile !== '4c4g' && profile !== '8c8g')
    throw new Error('QINGZHOU_BUILD_PROFILE must be 4c4g or 8c8g');
  return {
    cpus: profile === '4c4g' ? 2 : 4,
    staticGenerationMaxConcurrency: 2,
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
  } satisfies NextConfig['experimental'];
}
