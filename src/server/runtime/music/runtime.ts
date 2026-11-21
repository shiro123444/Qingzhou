import { createAtomicRuntimeFromProfile } from '../atomic-runtime';
import { assertBuiltinPluginEnabled } from '../builtin-plugins';

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
    modules: {
      music: async () => (await import('./atomic-plugin')).createMusicPlugin(),
      skills: async () => (await import('../skills-plugin')).createSkillsPlugin(() => runtime),
    },
    profile: { bundles: ['music'] },
  });
  return runtime;
}

let active: ReturnType<typeof createMusicRuntime> | undefined;
export const getMusicRuntime = () => {
  assertBuiltinPluginEnabled('music');
  if (active) return active;
  const runtime = createMusicRuntime();
  active = runtime;
  void runtime.ready().catch(async () => {
    if (active === runtime) active = undefined;
    await runtime.dispose().catch(() => undefined);
  });
  return runtime;
};
