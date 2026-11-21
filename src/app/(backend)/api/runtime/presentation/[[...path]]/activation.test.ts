// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import * as composition from '@/server/runtime/presentation/default-composition';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('does not assemble the PPT runtime on import or when its deployment plugin is disabled', async () => {
  const assemble = vi.spyOn(composition, 'getDefaultPresentationComposition');
  const route = await import('./route');
  expect(assemble).not.toHaveBeenCalled();
  vi.stubEnv('QINGZHOU_PLUGINS', 'music,sites');
  const response = await route.POST(
    new Request('http://localhost/api/runtime/presentation/generation', {
      method: 'POST',
    }),
  );
  expect(response.status).toBe(404);
  expect(assemble).not.toHaveBeenCalled();
  const handler = route.createPresentationRouteHandler();
  expect((await handler(new Request('http://localhost'))).status).toBe(404);
  expect(assemble).not.toHaveBeenCalled();
});
