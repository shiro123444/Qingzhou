import { afterEach, expect, it, vi } from 'vitest';

import * as assets from '../assets/plugin';
import * as skills from '../skills-plugin';
import * as teaching from '../teaching/atomic-plugin';
import { InMemoryPresentationArtifactStore } from './artifact-store';
import { createPresentationAtomicRuntime } from './atomic-plugin';
import { InMemoryPresentationPlanWorker } from './worker';

afterEach(() => vi.restoreAllMocks());

it('does not construct omitted PPT, asset, teaching, or skills modules', async () => {
  const assetFactory = vi.spyOn(assets, 'createAssetPlugin');
  const skillFactory = vi.spyOn(skills, 'createSkillsPlugin');
  const teachingFactory = vi.spyOn(teaching, 'createTeachingPlugin');
  const runtime = createPresentationAtomicRuntime({
    artifactStore: new InMemoryPresentationArtifactStore(),
    planner: { plan: vi.fn() },
    profile: {
      bundles: ['presentation'],
      patches: ['canvas', 'teaching', 'presentation', 'assets', 'skills'].map((id) => ({
        id,
        op: 'remove' as const,
      })),
    },
    worker: new InMemoryPresentationPlanWorker(),
  });
  try {
    await runtime.ready();
    expect(await runtime.pluginIds()).toEqual(['presentation-collaboration']);
    expect(assetFactory).not.toHaveBeenCalled();
    expect(skillFactory).not.toHaveBeenCalled();
    expect(teachingFactory).not.toHaveBeenCalled();
    await expect(
      runtime.invoke('presentation.plan', {}, { scope: { userId: 'alice', sessionId: 'one' } }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  } finally {
    await runtime.dispose();
  }
});
