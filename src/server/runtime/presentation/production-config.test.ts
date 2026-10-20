import { describe, expect, it } from 'vitest';

import { resolveProviderReadiness } from './production-command';
import {
  loadProductionPresentationProviderOptions,
  PRODUCTION_PRESENTATION_ENV_KEYS,
} from './production-config';

const validEnv = {
  [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
  [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify(['node', '/opt/ppt/runner.js']),
  [PRODUCTION_PRESENTATION_ENV_KEYS.commandArgs]: JSON.stringify(['--quiet']),
  [PRODUCTION_PRESENTATION_ENV_KEYS.runnerId]: 'ppt-master-runner',
  [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['ppt-master-runner']),
} as const;

describe('C-75 production provider configuration loader', () => {
  it('loads all supported environment values and remains consumable by C-73', () => {
    const options = loadProductionPresentationProviderOptions(validEnv);

    expect(options).toEqual({
      provider: 'ppt-master',
      command: ['node', '/opt/ppt/runner.js'],
      commandArgs: ['--quiet'],
      runnerId: 'ppt-master-runner',
      allowedRunnerIds: ['ppt-master-runner'],
    });
    expect(resolveProviderReadiness(options)).toMatchObject({
      available: true,
      commandAvailable: true,
      provider: 'ppt-master',
      runnerId: 'ppt-master-runner',
    });
  });
  it('exposes a deployable generated-image budget and rejects malformed values', () => {
    expect(
      loadProductionPresentationProviderOptions({
        ...validEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]: '16',
      }).imageBudget,
    ).toBe(16);
    expect(loadProductionPresentationProviderOptions(validEnv).imageBudget).toBeUndefined();
    expect(
      loadProductionPresentationProviderOptions({
        ...validEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]: '',
      }).imageBudget,
    ).toBeUndefined();
    expect(() =>
      loadProductionPresentationProviderOptions({
        ...validEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.imageBudget]: '-1',
      }),
    ).toThrow(/non-negative integer/u);
  });

  it('returns incomplete options for missing provider or command and C-73 stays unavailable', () => {
    const missing = loadProductionPresentationProviderOptions({});
    const missingCommand = loadProductionPresentationProviderOptions({
      [PRODUCTION_PRESENTATION_ENV_KEYS.provider]: 'ppt-master',
    });

    expect(missing).toEqual({});
    expect(missingCommand).toEqual({ provider: 'ppt-master' });
    expect(resolveProviderReadiness(missing)).toMatchObject({
      available: false,
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(resolveProviderReadiness(missingCommand)).toMatchObject({
      available: false,
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it.each([
    [PRODUCTION_PRESENTATION_ENV_KEYS.command, '{'],
    [PRODUCTION_PRESENTATION_ENV_KEYS.command, '[]'],
    [PRODUCTION_PRESENTATION_ENV_KEYS.commandArgs, '[]'],
    [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds, '[]'],
  ] as const)('rejects invalid JSON or empty arrays for %s', (key, value) => {
    expect(() => loadProductionPresentationProviderOptions({ [key]: value })).toThrowError(
      expect.objectContaining({ code: 'PRESENTATION_INVALID', path: key }),
    );
  });

  it('preserves allow-list validation and stable runner errors', () => {
    expect(() =>
      loadProductionPresentationProviderOptions({
        ...validEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.allowedRunnerIds]: JSON.stringify(['other-runner']),
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESENTATION_RUNNER_NOT_ALLOWED' }));
  });

  it('returns frozen defensive options that do not mutate across loads', () => {
    const first = loadProductionPresentationProviderOptions(validEnv);
    const second = loadProductionPresentationProviderOptions(validEnv);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.command)).toBe(true);
    expect(Object.isFrozen(first.commandArgs)).toBe(true);
    expect(Object.isFrozen(first.allowedRunnerIds)).toBe(true);
    expect(first).toEqual(second);
    expect(() => (first.command as string[]).push('changed')).toThrow();
    expect(() => (first.allowedRunnerIds as string[]).push('changed')).toThrow();
    expect(second.command).toEqual(['node', '/opt/ppt/runner.js']);
  });

  it('keeps secrets out of C-73 readiness projections and error text', () => {
    const secret = 'super-secret-token';
    const options = loadProductionPresentationProviderOptions({
      ...validEnv,
      [PRODUCTION_PRESENTATION_ENV_KEYS.command]: JSON.stringify([
        'node',
        '/private/runner.js',
        '--token',
        secret,
      ]),
      [PRODUCTION_PRESENTATION_ENV_KEYS.commandArgs]: JSON.stringify(['--secret', secret]),
    });
    const readiness = resolveProviderReadiness(options);

    expect(JSON.stringify(readiness)).not.toContain(secret);
    expect(JSON.stringify(readiness)).not.toContain('/private/runner.js');
    let thrown: unknown;
    try {
      loadProductionPresentationProviderOptions({
        ...validEnv,
        [PRODUCTION_PRESENTATION_ENV_KEYS.command]: '{"secret":"never-echo"}',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'PRESENTATION_INVALID' });
    expect((thrown as Error).message).not.toContain('never-echo');
  });
});
