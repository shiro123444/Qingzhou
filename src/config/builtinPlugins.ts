/** Public metadata only. Importing this catalog never imports a feature implementation. */
import type { ProfileModuleManifest } from '@lobechat/cordis-runtime';

export const BUILTIN_PLUGINS = {
  music: { botMention: true, id: 'music', routes: ['/music'], version: '1.0.0' },
  presentation: {
    botMention: true,
    id: 'presentation',
    routes: ['/presentation'],
    version: '1.0.0',
  },
  sites: { botMention: true, id: 'sites', routes: ['/sites'], version: '1.0.0' },
} as const satisfies Record<string, ProfileModuleManifest & { routes: readonly string[] }>;

export type BuiltinPluginId = keyof typeof BUILTIN_PLUGINS;

export const BUILTIN_PLUGIN_IDS = Object.keys(BUILTIN_PLUGINS) as BuiltinPluginId[];

export const isBuiltinPluginEnabled = (id: BuiltinPluginId, enabled?: readonly string[]) =>
  enabled === undefined || enabled.includes(id);

export function builtinPluginForPath(path: string): BuiltinPluginId | undefined {
  return BUILTIN_PLUGIN_IDS.find((id) =>
    BUILTIN_PLUGINS[id].routes.some((route) => path === route || path.startsWith(`${route}/`)),
  );
}

/** Absent preserves existing deployments; an explicit empty profile enables no trial plugins. */
export function parseBuiltinPluginProfile(value?: string): BuiltinPluginId[] {
  if (value === undefined) return [...BUILTIN_PLUGIN_IDS];
  const ids = [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.some((id) => !Object.hasOwn(BUILTIN_PLUGINS, id)))
    throw new Error('PLUGIN_PROFILE_INVALID');
  return ids as BuiltinPluginId[];
}
