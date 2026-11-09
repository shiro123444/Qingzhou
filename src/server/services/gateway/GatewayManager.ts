import { createHash } from 'node:crypto';

import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentBotProviderModel } from '@/database/models/agentBotProvider';
import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  type BotPlatformRuntimeContext,
  buildRuntimeKey,
  type PlatformClient,
  type PlatformDefinition,
  resolveBotProviderConfig,
} from '@/server/services/bot/platforms';
import { createSerialQueue } from '@/server/services/messenger/platforms/cordis/registry';

import { boundedGatewayIO, ConnectionLease } from './ConnectionLease';
import { CordisConnection } from './CordisConnection';
import { updateBotRuntimeStatus } from './runtimeStatus';

const log = debug('lobe-server:bot-gateway');

export interface GatewayManagerConfig {
  definitions: PlatformDefinition[];
  persistentOnly?: boolean;
}

export class GatewayManager {
  private clients = new Map<string, CordisConnection>();
  private revisions = new Map<string, string>();
  private readonly operations = createSerialQueue();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private syncing?: Promise<void>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private config: GatewayManagerConfig;

  private definitionByPlatform: Map<string, PlatformDefinition>;

  constructor(config: GatewayManagerConfig) {
    this.config = config;
    this.definitionByPlatform = new Map(this.config.definitions.map((e) => [e.id, e]));
  }

  get isRunning(): boolean {
    return this.running;
  }

  hasClient(platform: string, applicationId: string): boolean {
    return this.clients.get(buildRuntimeKey(platform, applicationId))?.isHeld ?? false;
  }

  // ------------------------------------------------------------------
  // Lifecycle (call once)
  // ------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.running) {
      log('GatewayManager already running, skipping');
      return;
    }

    log('Starting GatewayManager');

    this.starting = this.sync().then(() => {
      this.running = true;
      if (!this.stopping) {
        this.syncTimer = setInterval(() => {
          if (this.syncing || this.stopping) return;
          this.syncing = this.sync().finally(() => {
            this.syncing = undefined;
          });
          void this.syncing.catch(() => log('Channel reconciliation failed'));
        }, 30_000);
        this.syncTimer.unref?.();
      }
      log('GatewayManager started with %d clients', this.clients.size);
    });
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearInterval(this.syncTimer);
      for (const connection of this.clients.values()) connection.prepareStop();
      await this.starting;
      await this.syncing;
      await this.operations.settle();
      const results = await Promise.allSettled(
        [...this.clients.keys()].map((key) =>
          this.operations.run(key, () => this.disposeClient(key)),
        ),
      );
      this.running = false;
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) {
        throw new Error(`Failed to stop ${failures.length} channel connection(s)`);
      }
      log('GatewayManager stopped');
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  // ------------------------------------------------------------------
  // Client operations (point-to-point)
  // ------------------------------------------------------------------

  async startClient(
    platform: string,
    applicationId: string,
    userId: string,
  ): Promise<'started' | 'queued'> {
    this.assertAcceptingConnections();
    const key = buildRuntimeKey(platform, applicationId);
    return this.operations.run(key, async () => {
      this.assertAcceptingConnections();
      // Resolve the caller's installation before touching an existing transport.
      const provider = await boundedGatewayIO(async () => {
        const serverDB = await getServerDB();
        const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
        return new AgentBotProviderModel(serverDB, userId, gateKeeper).findEnabledByApplicationId(
          platform,
          applicationId,
        );
      });
      this.assertAcceptingConnections();
      if (!provider) return 'queued';
      await this.disposeClient(key);
      return this.mountClient(key, platform, provider);
    });
  }

  async stopClient(platform: string, applicationId: string): Promise<void> {
    const key = buildRuntimeKey(platform, applicationId);
    await this.operations.run(key, () => this.disposeClient(key));
    log('Stopped client %s', key);
  }

  // ------------------------------------------------------------------
  // DB sync
  // ------------------------------------------------------------------

  private async sync(): Promise<void> {
    for (const platform of this.definitionByPlatform.keys()) {
      try {
        await this.syncPlatform(platform);
      } catch (error) {
        console.error('[GatewayManager] Sync error for %s:', platform, error);
      }
    }
  }

  private async syncPlatform(platform: string): Promise<void> {
    const providers = await boundedGatewayIO(async () => {
      const serverDB = await getServerDB();
      const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
      return AgentBotProviderModel.findEnabledByPlatform(serverDB, platform, gateKeeper);
    });

    log('Sync: found %d enabled providers for %s', providers.length, platform);

    const activeKeys = new Set<string>();

    for (const provider of providers) {
      const { applicationId, credentials } = provider;
      const key = buildRuntimeKey(platform, applicationId);
      activeKeys.add(key);

      log('Sync: processing provider %s, hasCredentials=%s', key, !!credentials);

      try {
        await this.operations.run(key, async () => {
          if (this.stopping) return;
          if (this.clients.get(key)?.isHeld && this.revisions.get(key) === this.revision(provider))
            return;
          await this.disposeClient(key);
          await this.mountClient(key, platform, provider);
        });
      } catch (err) {
        log('Sync: failed to start client %s: %O', key, err);
      }
    }

    // Stop clients that are no longer in DB
    for (const key of this.clients.keys()) {
      if (!key.startsWith(`${platform}:`)) continue;
      if (activeKeys.has(key)) continue;

      log('Sync: client %s removed from DB, stopping', key);
      await this.operations.run(key, () => this.disposeClient(key));
    }
  }

  // ------------------------------------------------------------------
  // Factory
  // ------------------------------------------------------------------

  private assertAcceptingConnections(): void {
    if (this.stopping) throw new Error('Channel gateway is stopping');
  }

  private async disposeClient(key: string): Promise<void> {
    const connection = this.clients.get(key);
    if (!connection) return;
    await connection.dispose();
    // Retain failed disposals so a replacement cannot overlap the old transport.
    if (this.clients.get(key) === connection) {
      this.clients.delete(key);
      this.revisions.delete(key);
    }
  }

  private revision(
    provider: Parameters<GatewayManager['createClient']>[1] & { agentId?: string; userId?: string },
  ): string {
    const { channelIdentity: _identity, ...settings } = provider.settings ?? {};
    // Binding revisions are checked at authorization time and do not alter the transport.
    return createHash('sha256')
      .update(
        JSON.stringify({
          agentId: provider.agentId,
          applicationId: provider.applicationId,
          credentials: provider.credentials,
          settings,
          userId: provider.userId,
        }),
      )
      .digest('hex');
  }

  private async mountClient(
    key: string,
    platform: string,
    provider: Parameters<GatewayManager['createClient']>[1],
  ): Promise<'started' | 'queued'> {
    const definition = this.definitionByPlatform.get(platform);
    if (!definition) return 'queued';
    const { connectionMode } = resolveBotProviderConfig(definition, provider);
    if (this.config.persistentOnly && connectionMode === 'webhook') return 'queued';
    let connection: CordisConnection | undefined;
    const requiresLease =
      connectionMode !== 'webhook' && ['wechat', 'napcat', 'qq', 'feishu', 'lark'].includes(platform);
    const lease = !requiresLease
      ? undefined
      : await ConnectionLease.acquire(getAgentRuntimeRedisClient(), key, () => {
          connection?.interrupt();
          void this.operations
            .run(key, async () => {
              if (connection && this.clients.get(key) === connection) await this.disposeClient(key);
            })
            .catch(() => log('Failed to dispose revoked channel connection'));
        });
    if (requiresLease && !lease) return 'queued';
    try {
      this.assertAcceptingConnections();
      const client = this.createClient(platform, provider, lease);
      if (!client) {
        await lease?.release();
        return 'queued';
      }
      connection = new CordisConnection(client, lease);
      this.clients.set(key, connection);
      this.revisions.set(key, this.revision(provider));
      await connection.ready;
      return 'started';
    } catch (error) {
      if (connection) await this.disposeClient(key);
      else await lease?.release();
      throw error;
    }
  }

  private createClient(
    platform: string,
    provider: {
      applicationId: string;
      credentials: Record<string, string>;
      settings?: Record<string, unknown> | null;
    },
    lease?: ConnectionLease,
  ): PlatformClient | null {
    const def = this.definitionByPlatform.get(platform);
    if (!def) {
      log('No definition registered for platform: %s', platform);
      return null;
    }

    const { config } = resolveBotProviderConfig(def, provider);

    const context: BotPlatformRuntimeContext = {
      assertConnectionHeld: lease?.assertHeld,
      appUrl: process.env.APP_URL,
      redisClient: getAgentRuntimeRedisClient() as any,
      updateRuntimeStatus: lease
        ? (params, options) =>
            updateBotRuntimeStatus(params, {
              ...options,
              connectionLease: lease,
            })
        : undefined,
      pollingCursorStore:
        platform === 'wechat'
          ? {
              load: async () => {
                const { BotInboundModel } = await import('@/database/models/botInbound');
                const { getServerDB } = await import('@/database/core/db-adaptor');
                return new BotInboundModel(await getServerDB()).getCursor(
                  `wechat:${provider.applicationId}`,
                );
              },
              save: async (cursor) => {
                const { BotInboundModel } = await import('@/database/models/botInbound');
                const { getServerDB } = await import('@/database/core/db-adaptor');
                await new BotInboundModel(await getServerDB()).saveCursor(
                  `wechat:${provider.applicationId}`,
                  cursor,
                );
              },
            }
          : undefined,
    };

    return def.clientFactory.createClient(config, context);
  }
}

// ------------------------------------------------------------------
// Singleton
// ------------------------------------------------------------------

const globalForGateway = globalThis as unknown as { gatewayManager?: GatewayManager };

export function getGatewayManager(): GatewayManager | undefined {
  return globalForGateway.gatewayManager;
}

export function createGatewayManager(config: GatewayManagerConfig): GatewayManager {
  if (!globalForGateway.gatewayManager) {
    globalForGateway.gatewayManager = new GatewayManager(config);
  }
  return globalForGateway.gatewayManager;
}
