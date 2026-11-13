import { Context } from '@lobechat/cordis-foundation';

import type { PlatformClient } from '@/server/services/bot/platforms/types';

import { boundedGatewayIO, type ConnectionLease } from './ConnectionLease';

/** One installation owns one native plugin and its transport teardown. */
export class CordisConnection {
  readonly context = new Context();
  readonly ready: Promise<void>;
  private client?: PlatformClient;
  private closeTask?: Promise<void>;
  private disposeTask?: Promise<void>;
  private closed = false;
  private rootDisposed = false;
  private cleanupFailed = false;
  private cleanupError: unknown;
  private acquired = false;
  private interruptTask?: Promise<void>;
  private cancelStartup?: () => void;
  private interrupted = false;

  get isHeld(): boolean {
    return !this.closed && (this.lease?.isHeld ?? true);
  }

  constructor(
    source: PlatformClient | { id: string; load: () => Promise<PlatformClient> },
    private readonly lease?: ConnectionLease,
  ) {
    if (!('load' in source)) this.client = source;
    let startupFailed = false;
    let startupError: unknown;
    const fiber = this.context.plugin({
      name: `bot-channel.${source.id}`,
      apply: async (ctx: Context) => {
        // Register before acquiring so a partially failed start is reclaimed too.
        ctx.effect(() => () => this.close(), 'channel.transport');
        const canceled = new Promise<never>((_, reject) => {
          this.cancelStartup = () => reject(new Error('Channel connection startup interrupted'));
        });
        const timeout = setTimeout(() => this.interrupt(), 60_000);
        timeout.unref?.();
        const starting = Promise.resolve().then(async () => {
          if (this.interrupted) throw new Error('Channel connection startup interrupted');
          const client = 'load' in source ? await source.load() : source;
          this.client = client;
          // Imports cannot be aborted. A late module must never open a revoked transport.
          if (this.interrupted) return;
          this.lease?.assertHeld();
          await client.start();
        });
        // A late SDK acquisition must also release anything it created after cancellation.
        void starting
          .finally(async () => {
            if (!this.interrupted) return;
            // Loading may finish while close() is releasing the lease, after its stop check.
            await this.closeTask;
            const client = this.client;
            if (this.closed && client) await boundedGatewayIO(() => client.stop(), 35_000);
          })
          .catch(() => undefined);
        try {
          await Promise.race([starting, canceled]);
          this.lease?.assertHeld();
        } catch (error) {
          startupFailed = true;
          startupError = error;
        } finally {
          clearTimeout(timeout);
          this.cancelStartup = undefined;
          this.acquired = true;
        }
      },
    });
    this.ready = Promise.resolve(fiber).then(() => {
      if (startupFailed) throw startupError;
    });
    // The manager awaits ready, but startup may reject before its next await.
    void this.ready.catch(() => undefined);
  }

  prepareStop(): void {
    this.lease?.stopAccepting();
    if (!this.acquired) this.interrupt();
  }

  /** Interrupt SDK acquisition immediately; normal disposal joins startup afterwards. */
  interrupt(): void {
    this.interrupted = true;
    this.lease?.stopAccepting();
    this.cancelStartup?.();
    if (this.acquired) {
      void this.close();
      return;
    }
    const client = this.client;
    if (!this.acquired && !this.interruptTask && client) {
      this.interruptTask = boundedGatewayIO(() => client.stop(), 35_000).catch(() => undefined);
    }
  }

  private close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closeTask) return this.closeTask;
    this.lease?.stopAccepting();
    this.closeTask = Promise.resolve()
      .then(async () => {
        await this.interruptTask;
        const client = this.client;
        if (client) await boundedGatewayIO(() => client.stop(), 35_000);
        await this.lease?.release();
      })
      .then(
        () => {
          this.closed = true;
          this.cleanupFailed = false;
        },
        (error: unknown) => {
          // Cordis logs teardown errors. Retain them locally instead, so callers
          // can retry cleanup without emitting SDK errors containing credentials.
          this.cleanupFailed = true;
          this.cleanupError = error;
        },
      )
      .finally(() => {
        this.closeTask = undefined;
      });
    return this.closeTask;
  }

  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    this.prepareStop();
    this.disposeTask = (async () => {
      if (this.rootDisposed) {
        await this.close();
      } else {
        await this.context.fiber.dispose();
        this.rootDisposed = true;
      }
      if (this.cleanupFailed) throw this.cleanupError;
    })().catch((error: unknown) => {
      this.disposeTask = undefined;
      throw error;
    });
    return this.disposeTask;
  }
}
