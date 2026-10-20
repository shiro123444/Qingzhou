import { afterEach, expect, it, vi } from 'vitest';

import { defineConfig } from './define-config';

afterEach(() => vi.unstubAllEnvs());

it('keeps standalone math/font resources while adding PDF character maps for API routes', () => {
  vi.stubEnv('NEXT_BUILD_STANDALONE', '1');
  const config = defineConfig({
    outputFileTracingIncludes: { '/api/**': ['node_modules/pdfjs-dist/cmaps/**'] },
  });
  expect(config.outputFileTracingIncludes?.['*']).toContain('node_modules/@mathjax/src/mjs/**/*');
  expect(config.outputFileTracingIncludes?.['/api/**']).toEqual([
    'node_modules/pdfjs-dist/cmaps/**',
  ]);
});

it('loads Markdown templates in Webpack development without a compact build profile', () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('QINGZHOU_BUILD_PROFILE', '');
  const config = defineConfig({});
  expect(config.experimental?.webpackMemoryOptimizations).toBe(true);
  const webpackConfig = { cache: true, module: { rules: [] } };
  const result = config.webpack!(webpackConfig, {} as any);
  expect(result.module.rules).toContainEqual({ test: /\.md$/, type: 'asset/source' });
  expect(result.cache).toBe(true);
});
