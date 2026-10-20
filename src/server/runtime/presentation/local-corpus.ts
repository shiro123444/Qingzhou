import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { presentationAccountScope } from './account-workspace';
import type { PresentationArtifactStore } from './artifact-store';
import type { CapabilityMemory } from './capability-memory';
import type { FilePresentationTemplateLibrary } from './templates';

/** Seed only the corpus explicitly configured by the local application owner. No jobs or feedback migrate. */
export function createLocalCorpusSeeder(options: {
  sourceUserId: string;
  library: FilePresentationTemplateLibrary;
  store: PresentationArtifactStore;
  memory: CapabilityMemory;
}) {
  const pending = new Map<string, Promise<void>>();
  return async (scope: RuntimeScope) => {
    if (!scope.userId?.trim() || !scope.sessionId?.trim())
      throw new Error('Authenticated corpus target is required');
    const key = `${scope.userId}\0${scope.sessionId}`;
    const running = pending.get(key);
    if (running) return running;
    const task = (async () => {
      const sourceScope = presentationAccountScope(options.sourceUserId);
      const templates = await options.library.list(sourceScope);
      for (const reference of templates) {
        const visual = await options.library.getVisual(sourceScope, reference);
        if (!visual || visual.learning.status !== 'ready') continue;
        await options.library.copyCorpusVersion(sourceScope, scope, reference);
        const refs = [
          ...visual.pages.map(({ ref }) => ref),
          ...(visual.styleAtlas ?? []).map(({ ref }) => ref),
        ];
        for (const ref of new Set(refs)) {
          if ((await options.store.get(scope, ref))?.bytes) continue;
          const asset = await options.store.get(sourceScope, ref);
          if (
            !asset?.bytes ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? '')
          )
            throw new Error('Corpus reference pixels are unavailable');
          await options.store.put(scope, { ...asset, mimeType: asset.mimeType!, name: asset.name ?? `${ref}.png` });
        }
        await options.library.saveVisual(scope, visual);
        await options.memory.learn(scope, visual);
      }
    })();
    pending.set(key, task);
    try {
      await task;
    } finally {
      pending.delete(key);
    }
  };
}
