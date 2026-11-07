import { createAtomicRuntimeFromProfile } from '../atomic-runtime';
import { createSkillsPlugin } from '../skills-plugin';
import { createMusicPlugin } from './atomic-plugin';

export function createMusicRuntime() {
  const runtime = createAtomicRuntimeFromProfile({
    bundles: {
      music: {
        entries: [
          { id: 'music', use: 'music' },
          { id: 'skills', use: 'skills' },
        ],
      },
    },
    modules: { music: createMusicPlugin(), skills: createSkillsPlugin(() => runtime) },
    profile: { bundles: ['music'] },
  });
  return runtime;
}

let active: ReturnType<typeof createMusicRuntime> | undefined;
export const getMusicRuntime = () => (active ??= createMusicRuntime());
