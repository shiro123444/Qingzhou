import debug from 'debug';
import type { Context } from 'hono';
import { after } from 'next/server';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { platformRegistry, resolveConnectionMode } from '@/server/services/bot/platforms';
import { BotConnectQueue } from '@/server/services/gateway/botConnectQueue';
import { GatewayManager } from '@/server/services/gateway/GatewayManager';

const log = debug('lobe-server:bot:gateway:cron');

// A single gateway invocation keeps persistent bots alive for one
// serverless cron window. Keep this aligned with BotConnectQueue.EXPIRE_MS
// so connect requests queued during the same window can still be consumed.
const GATEWAY_DURATION_MS = 600_000; // 10 minutes
const POLL_INTERVAL_MS = 30_000; // 30 seconds

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function processConnectQueue(manager: GatewayManager): Promise<number> {
  const queue = new BotConnectQueue();
  const items = await queue.popAll();

  if (items.length === 0) return 0;

  log('Processing %d queued connect requests', items.length);

  const serverDB = await getServerDB();
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  let processed = 0;

  for (const item of items) {
    try {
      const definition = platformRegistry.getPlatform(item.platform);
      if (!definition) {
        log('Skipping queued unknown platform=%s appId=%s', item.platform, item.applicationId);
        await queue.remove(item.platform, item.applicationId);
        continue;
      }

      const model = new AgentBotProviderModel(serverDB, item.userId, gateKeeper);
      const provider = await model.findEnabledByApplicationId(item.platform, item.applicationId);

      if (!provider) {
        log('No enabled provider found for queued %s appId=%s', item.platform, item.applicationId);
        await queue.remove(item.platform, item.applicationId);
        continue;
      }

      const effectiveMode = resolveConnectionMode(definition, provider.settings);
      if (effectiveMode === 'webhook') {
        log(
          'Skipping queued webhook-mode provider platform=%s appId=%s',
          item.platform,
          item.applicationId,
        );
        await queue.remove(item.platform, item.applicationId);
        continue;
      }

      const status = await manager.startClient(item.platform, item.applicationId, item.userId);
      if (status === 'started') {
        processed++;
        await queue.remove(item.platform, item.applicationId);
        log('Started queued bot platform=%s appId=%s', item.platform, item.applicationId);
      }
    } catch (err) {
      log(
        'Failed to start queued bot platform=%s appId=%s: %O',
        item.platform,
        item.applicationId,
        err,
      );
    }
  }

  return processed;
}

/**
 * Cron-driven gateway entry point. Runs once per Vercel cron tick and keeps
 * persistent bot connections alive for a 10-minute window via `next/server`'s
 * `after()`.
 *
 * Auth: `bearerSecretAuth(CRON_SECRET)` on the route.
 */
export async function gatewayCron(c: Context): Promise<Response> {
  // When the external message gateway is enabled, sync connections via gateway.
  if (process.env.MESSAGE_GATEWAY_URL && process.env.MESSAGE_GATEWAY_SERVICE_TOKEN) {
    const { GatewayService } = await import('@/server/services/gateway');
    const service = new GatewayService();

    if (service.useMessageGateway) {
      await service.ensureRunning();
      return c.json({ ensureRunning: true });
    }
  }

  const platforms = platformRegistry.listPlatforms();
  const manager = new GatewayManager({ definitions: platforms, persistentOnly: true });
  const pollEnd = Date.now() + GATEWAY_DURATION_MS;
  try {
    await manager.start();
    const serverDB = await getServerDB();
    const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
    let started = 0;
    let total = 0;
    const stats: Array<{ platform: string; started: number; total: number }> = [];

    for (const platform of platforms) {
      const providers = await AgentBotProviderModel.findEnabledByPlatform(
        serverDB,
        platform.id,
        gateKeeper,
      );
      const persistent = providers.filter(
        (provider) => resolveConnectionMode(platform, provider.settings) !== 'webhook',
      );
      const owned = persistent.filter((provider) =>
        manager.hasClient(platform.id, provider.applicationId),
      );
      started += owned.length;
      total += persistent.length;
      stats.push({ platform: platform.id, started: owned.length, total: persistent.length });
    }

    const queued = await processConnectQueue(manager);
    after(async () => {
      try {
        while (Date.now() < pollEnd) {
          await sleep(Math.min(POLL_INTERVAL_MS, pollEnd - Date.now()));
          if (Date.now() >= pollEnd) break;
          await processConnectQueue(manager);
        }
      } finally {
        await manager.stop();
      }
    });
    return c.json({ platforms: stats, queued, started, total });
  } catch (error) {
    await manager.stop();
    throw error;
  }
}
