import { afterEach, expect, it, vi } from 'vitest';

import { builtinPluginForPath, parseBuiltinPluginProfile } from '@/config/builtinPlugins';

import { assertBuiltinPluginEnabled, withBuiltinPlugin } from './builtin-plugins';

afterEach(() => vi.unstubAllEnvs());

it('defaults to the existing plugins, supports an empty deployment, and rejects unknown code names', () => {
  expect(parseBuiltinPluginProfile()).toEqual(['music', 'presentation', 'sites']);
  expect(parseBuiltinPluginProfile('')).toEqual([]);
  expect(parseBuiltinPluginProfile(' music, sites, music ')).toEqual(['music', 'sites']);
  expect(() => parseBuiltinPluginProfile('music,../../code')).toThrow('PLUGIN_PROFILE_INVALID');
  expect(builtinPluginForPath('/music/playlists/one')).toBe('music');
  expect(builtinPluginForPath('/musical')).toBeUndefined();
});

it('rejects a disabled endpoint before invoking its service factory', async () => {
  vi.stubEnv('QINGZHOU_PLUGINS', 'sites');
  const load = vi.fn(async () => Response.json({ ok: true }));
  const handler = withBuiltinPlugin('music', load);
  const response = await handler();
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'PLUGIN_DISABLED' });
  expect(load).not.toHaveBeenCalled();
  expect(() => assertBuiltinPluginEnabled('music')).toThrow('disabled');
});

it('preserves arguments for enabled handlers and fails closed on an invalid profile', async () => {
  vi.stubEnv('QINGZHOU_PLUGINS', 'music');
  const load = vi.fn(async (owner: string) => Response.json({ owner }));
  const handler = withBuiltinPlugin('music', load);
  expect(await (await handler('alice')).json()).toEqual({ owner: 'alice' });
  vi.stubEnv('QINGZHOU_PLUGINS', 'unknown');
  expect((await handler('bob')).status).toBe(503);
  expect(load).toHaveBeenCalledTimes(1);
});
