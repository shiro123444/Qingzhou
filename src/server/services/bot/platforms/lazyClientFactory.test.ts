import { describe, expect, it, vi } from 'vitest';

import { LazyClientFactory } from './lazyClientFactory';
import { ClientFactory, type PlatformClient } from './types';

const config = { applicationId: 'app', credentials: {}, platform: 'test', settings: {} };

class TestFactory extends ClientFactory {
  createClient = vi.fn(() => ({ id: 'test' }) as PlatformClient);
  validateCredentials = vi.fn(async () => ({ valid: true }));
  validateSettings = vi.fn(async () => ({ valid: false }));
}

describe('LazyClientFactory', () => {
  it('shares code loading across operations, while creating a separate client for each caller', async () => {
    const factory = new TestFactory();
    const load = vi.fn(async () => factory);
    const lazy = new LazyClientFactory(load);
    expect(load).not.toHaveBeenCalled();
    const context = { appUrl: 'https://example.com' };
    const [first, second, credentials, settings] = await Promise.all([
      lazy.createClient(config, context),
      lazy.createClient({ ...config, applicationId: 'other' }, {}),
      lazy.validateCredentials({ token: 'test' }, { mode: 'test' }, 'app', 'test'),
      lazy.validateSettings({ mode: 'test' }),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    expect(factory.createClient).toHaveBeenNthCalledWith(1, config, context);
    expect(factory.createClient).toHaveBeenNthCalledWith(
      2,
      { ...config, applicationId: 'other' },
      {},
    );
    expect(factory.validateCredentials).toHaveBeenCalledWith(
      { token: 'test' },
      { mode: 'test' },
      'app',
      'test',
    );
    expect(factory.validateSettings).toHaveBeenCalledWith({ mode: 'test' });
    expect(credentials).toEqual({ valid: true });
    expect(settings).toEqual({ valid: false });
  });

  it('allows a later attempt after a shared import fails', async () => {
    const factory = new TestFactory();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue(factory);
    const lazy = new LazyClientFactory(load);
    const results = await Promise.allSettled([
      lazy.createClient(config, {}),
      lazy.validateSettings({}),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(lazy.createClient(config, {})).resolves.toMatchObject({ id: 'test' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not reload the SDK or retry an operation when client construction fails', async () => {
    const factory = new TestFactory();
    factory.createClient.mockImplementationOnce(() => {
      throw new Error('invalid config');
    });
    const load = vi.fn(async () => factory);
    const lazy = new LazyClientFactory(load);
    await expect(lazy.createClient(config, {})).rejects.toThrow('invalid config');
    expect(factory.createClient).toHaveBeenCalledTimes(1);
    await lazy.createClient(config, {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(factory.createClient).toHaveBeenCalledTimes(2);
  });
});
