// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gatewayCron } from '../gatewayCron';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  ensureRunning: vi.fn(),
  findEnabledByApplicationId: vi.fn(),
  findEnabledByPlatform: vi.fn(),
  getServerDB: vi.fn(),
  manager: {
    hasClient: vi.fn(),
    start: vi.fn(),
    startClient: vi.fn(),
    stop: vi.fn(),
  },
  managerConstructor: vi.fn(),
  platforms: [{ id: 'qq', name: 'QQ' }],
  popAll: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: mocks.getServerDB }));
vi.mock('@/database/models/agentBotProvider', () => ({
  AgentBotProviderModel: Object.assign(
    vi.fn().mockImplementation(() => ({
      findEnabledByApplicationId: mocks.findEnabledByApplicationId,
    })),
    { findEnabledByPlatform: mocks.findEnabledByPlatform },
  ),
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@/server/services/bot/platforms', () => ({
  platformRegistry: {
    getPlatform: (id: string) => mocks.platforms.find((platform) => platform.id === id),
    listPlatforms: () => mocks.platforms,
  },
  resolveConnectionMode: (_platform: unknown, settings?: { connectionMode?: string }) =>
    settings?.connectionMode ?? 'websocket',
}));
vi.mock('@/server/services/gateway/botConnectQueue', () => ({
  BotConnectQueue: vi.fn().mockImplementation(() => ({
    popAll: mocks.popAll,
    remove: mocks.remove,
  })),
}));
vi.mock('@/server/services/gateway/GatewayManager', () => ({
  GatewayManager: mocks.managerConstructor,
}));
vi.mock('@/server/services/gateway', () => ({
  GatewayService: vi.fn().mockImplementation(() => ({
    ensureRunning: mocks.ensureRunning,
    useMessageGateway: true,
  })),
}));

const context = { json: (body: unknown) => Response.json(body) } as any;
const item = { applicationId: 'app-1', platform: 'qq', userId: 'owner' };
const provider = { applicationId: 'app-1', credentials: {}, settings: {} };

describe('gatewayCron leased connections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.after.mockReset();
    mocks.popAll.mockReset();
    mocks.findEnabledByApplicationId.mockReset();
    mocks.findEnabledByPlatform.mockReset();
    mocks.manager.start.mockReset();
    mocks.manager.startClient.mockReset();
    vi.stubEnv('MESSAGE_GATEWAY_URL', '');
    vi.stubEnv('MESSAGE_GATEWAY_SERVICE_TOKEN', '');
    mocks.managerConstructor.mockImplementation(() => mocks.manager);
    mocks.manager.start.mockResolvedValue(undefined);
    mocks.manager.stop.mockResolvedValue(undefined);
    mocks.manager.startClient.mockResolvedValue('started');
    mocks.manager.hasClient.mockReturnValue(false);
    mocks.getServerDB.mockResolvedValue({});
    mocks.findEnabledByPlatform.mockResolvedValue([]);
    mocks.findEnabledByApplicationId.mockResolvedValue(provider);
    mocks.popAll.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const runWindow = async () => {
    const task = mocks.after.mock.calls[0][0]() as Promise<void>;
    await vi.advanceTimersByTimeAsync(600_000);
    await task;
  };

  it('uses one persistent-only manager and reports only locally owned connections', async () => {
    mocks.findEnabledByPlatform.mockResolvedValue([
      provider,
      { ...provider, applicationId: 'remote-app' },
      { ...provider, applicationId: 'webhook-app', settings: { connectionMode: 'webhook' } },
    ]);
    mocks.manager.hasClient.mockImplementation((_platform, appId) => appId === 'app-1');

    const response = await gatewayCron(context);

    expect(mocks.managerConstructor).toHaveBeenCalledWith({
      definitions: mocks.platforms,
      persistentOnly: true,
    });
    expect(await response.json()).toEqual({
      platforms: [{ platform: 'qq', started: 1, total: 2 }],
      queued: 0,
      started: 1,
      total: 2,
    });
    expect(mocks.manager.stop).not.toHaveBeenCalled();
    await runWindow();
    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
  });

  it('retains a queued request owned elsewhere and retries through the same manager', async () => {
    mocks.popAll.mockResolvedValueOnce([item]).mockResolvedValueOnce([item]);
    mocks.manager.startClient.mockResolvedValueOnce('queued').mockResolvedValueOnce('started');

    const response = await gatewayCron(context);
    expect((await response.json()).queued).toBe(0);
    expect(mocks.remove).not.toHaveBeenCalled();
    await runWindow();

    expect(mocks.manager.startClient).toHaveBeenCalledTimes(2);
    expect(mocks.manager.startClient).toHaveBeenCalledWith('qq', 'app-1', 'owner');
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('retains a transiently failing request for the next poll', async () => {
    mocks.popAll.mockResolvedValueOnce([item]);
    mocks.manager.startClient.mockRejectedValueOnce(new Error('temporary backend outage'));

    await gatewayCron(context);

    expect(mocks.remove).not.toHaveBeenCalled();
    await runWindow();
    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
  });

  it('removes stale disabled, unknown-platform and webhook-only requests', async () => {
    mocks.popAll.mockResolvedValueOnce([
      item,
      { ...item, platform: 'unknown' },
      { ...item, applicationId: 'webhook-app' },
    ]);
    mocks.findEnabledByApplicationId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...provider, settings: { connectionMode: 'webhook' } });

    await gatewayCron(context);

    expect(mocks.manager.startClient).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledTimes(3);
    await runWindow();
  });

  it('stops partially started connections when setup fails', async () => {
    mocks.manager.start.mockRejectedValueOnce(new Error('startup failed'));

    await expect(gatewayCron(context)).rejects.toThrow('startup failed');

    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('stops connections when the background queue reader fails', async () => {
    mocks.popAll.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('queue unavailable'));
    await gatewayCron(context);
    const task = mocks.after.mock.calls[0][0]() as Promise<void>;
    const rejected = expect(task).rejects.toThrow('queue unavailable');

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
  });

  it('stops connections if after cannot register the background window', async () => {
    mocks.after.mockImplementationOnce(() => {
      throw new Error('after unavailable');
    });

    await expect(gatewayCron(context)).rejects.toThrow('after unavailable');

    expect(mocks.manager.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves external message-gateway synchronization', async () => {
    vi.stubEnv('MESSAGE_GATEWAY_URL', 'http://localhost:9999');
    vi.stubEnv('MESSAGE_GATEWAY_SERVICE_TOKEN', 'test-only-token');

    const response = await gatewayCron(context);

    expect(await response.json()).toEqual({ ensureRunning: true });
    expect(mocks.ensureRunning).toHaveBeenCalledTimes(1);
    expect(mocks.managerConstructor).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
