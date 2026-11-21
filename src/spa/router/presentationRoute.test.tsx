import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { matchRoutes } from 'react-router-dom';

import { describe, expect, it } from 'vitest';

import { BuiltinPluginBoundary } from '@/features/BuiltinPlugins';

import { mobileRoutes } from './mobileRouter.config';

/**
 * Guards the C-58 PresentationStudio route registration. The desktop router
 * configs must stay in sync — desktopRouter.sync.test.tsx only asserts parity,
 * this one asserts the presentation route actually exists in both.
 */
const readRouterSources = () =>
  Promise.all([
    readFileSync(nodePath.join(process.cwd(), 'src/spa/router/desktopRouter.config.tsx'), 'utf8'),
    readFileSync(
      nodePath.join(process.cwd(), 'src/spa/router/desktopRouter.config.desktop.tsx'),
      'utf8',
    ),
  ]);

describe('presentation route registration', () => {
  it('opens chat delivery links on the mobile router through the presentation plugin', () => {
    const match = matchRoutes(mobileRoutes, '/presentation?jobId=work')?.at(-1);
    expect(match?.route.path).toBe('presentation');
    expect(match?.route.element).toMatchObject({
      type: BuiltinPluginBoundary,
      props: { id: 'presentation' },
    });
  });

  it('registers the /presentation route in the web (async) router config', async () => {
    const [asyncSource] = await readRouterSources();

    expect(asyncSource).toContain("path: 'presentation'");
    expect(asyncSource).toContain("import('@/routes/(main)/presentation')");
  });

  it('keeps the /presentation plugin lazy in the Electron router config', async () => {
    const [, syncSource] = await readRouterSources();

    expect(syncSource).toContain("path: 'presentation'");
    expect(syncSource).toContain("import('@/routes/(main)/presentation')");
    expect(syncSource).not.toContain("from '@/routes/(main)/presentation'");
    expect(syncSource).toContain('builtinPluginElement(');
  });
});
