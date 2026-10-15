import { afterEach, expect, it, vi } from 'vitest';

import { defineConfig } from './define-config';

afterEach(() => vi.unstubAllEnvs());

it('keeps standalone math/font resources while adding PDF character maps for API routes', () => {
  vi.stubEnv('NEXT_BUILD_STANDALONE', '1');
  const config = defineConfig({ outputFileTracingIncludes: { '/api/**': ['node_modules/pdfjs-dist/cmaps/**'] } });
  expect(config.outputFileTracingIncludes?.['*']).toContain('node_modules/@mathjax/src/mjs/**/*');
  expect(config.outputFileTracingIncludes?.['/api/**']).toEqual(['node_modules/pdfjs-dist/cmaps/**']);
});
