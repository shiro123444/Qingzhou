import { type BuiltinPluginId, isBuiltinPluginEnabled } from '@/config/builtinPlugins';
import { builtinPluginSelectors, useServerConfigStore } from '@/store/serverConfig';

export function useBuiltinPluginEnabled(id: BuiltinPluginId) {
  return isBuiltinPluginEnabled(id, useServerConfigStore(builtinPluginSelectors.enabled));
}
