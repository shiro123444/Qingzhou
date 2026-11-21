import {
  type BuiltinPluginId,
  isBuiltinPluginEnabled,
  parseBuiltinPluginProfile,
} from '@/config/builtinPlugins';

/** Deployment-owned selection. Neither request parameters nor models can change it. */
export const getEnabledBuiltinPlugins = () =>
  parseBuiltinPluginProfile(process.env.QINGZHOU_PLUGINS);

export function assertBuiltinPluginEnabled(id: BuiltinPluginId) {
  if (!isBuiltinPluginEnabled(id, getEnabledBuiltinPlugins()))
    throw Object.assign(new Error(`Plugin ${id} is disabled`), { code: 'PLUGIN_DISABLED' });
}

export function builtinPluginUnavailableResponse(id: BuiltinPluginId): Response | undefined {
  try {
    assertBuiltinPluginEnabled(id);
  } catch (error) {
    const disabled = (error as { code?: string }).code === 'PLUGIN_DISABLED';
    return Response.json(
      { code: disabled ? 'PLUGIN_DISABLED' : 'PLUGIN_PROFILE_INVALID', success: false },
      { headers: { 'Cache-Control': 'no-store' }, status: disabled ? 404 : 503 },
    );
  }
}

/** Keep the existing authentication boundary; reject before constructing domain services. */
export function withBuiltinPlugin<Args extends unknown[]>(
  id: BuiltinPluginId,
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> =>
    builtinPluginUnavailableResponse(id) ?? handler(...args);
}
